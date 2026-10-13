import type { Address } from "viem";
import { readAllowance, readHoldings, readSeries, type Holdings, type SeriesState } from "./chain.js";
import { SWAP_DEADLINE_SECONDS, loadKuru, type Deps, type KuruView } from "./context.js";
import { PiryError } from "./errors.js";
import { balanceOf, depositTx, estimateSwap, readAccount, swapTx, withdrawTx, type KuruMarket, type SwapEstimate } from "./kuru.js";
import { ceilDiv, claimsForGpuHours, fmt, netLong, slippageFloor } from "./math.js";
import { executeSale, planSale, type SalePlan } from "./sell.js";
import { Budget, Run, approveTx, mintPairsTx, transferTx, type StepLog } from "./tx.js";

export interface HedgeInput {
  gpuHoursMicro: bigint;
  maxPremium: bigint | null;
  slippageBps: number;
  allowMint: boolean;
  shortTo: Address | null;
}

export type HedgeStatus = "HEDGED" | "PARTIAL" | "PREVIEW" | "ALREADY_HEDGED" | "UNAVAILABLE" | "UNHEDGED_PAIR";

export interface HedgeResult {
  status: HedgeStatus;
  path: "kuru" | "mint" | "none";
  executed: boolean;
  targetClaims: string;
  alreadyHeldNetLong: string;
  claimsToAcquire: string;
  plan: Record<string, string>;
  after?: { claimsLong: string; claimsShort: string; netLong: string; spentUsdc: string };
  steps: StepLog[];
  warnings: string[];
  next: string;
}

export interface BuySizing {
  amountIn: bigint;
  expectedOut: bigint;
  complete: boolean;
}

export function askCost(claims: bigint, askRaw: bigint, market: KuruMarket): bigint {
  const cost = ceilDiv(claims * askRaw * 10n ** BigInt(market.quoteDecimals), market.pricePrecision * 10n ** BigInt(market.baseDecimals));
  return cost > 0n ? cost : 1n;
}

// Raises the quote budget until the estimator says the wanted claims fit, never past the cap. The estimator is
// the market's own, so book depth and fees are already in its answer.
export async function sizeBuy(
  estimate: (amountIn: bigint) => Promise<SwapEstimate>,
  wanted: bigint,
  start: bigint,
  cap: bigint | null,
): Promise<BuySizing> {
  const limit = (n: bigint) => (cap !== null && n > cap ? cap : n);
  let amountIn = limit(start);
  let best: BuySizing = { amountIn: 0n, expectedOut: 0n, complete: false };
  for (let i = 0; i < 8 && amountIn > 0n; i++) {
    const est = await estimate(amountIn);
    if (est.amountOut > best.expectedOut) {
      best = { amountIn: est.amountInUsed < amountIn ? est.amountInUsed : amountIn, expectedOut: est.amountOut, complete: est.amountOut >= wanted };
    }
    const bookExhausted = est.amountInUsed < amountIn;
    if (est.amountOut >= wanted || bookExhausted || (cap !== null && amountIn >= cap)) break;
    const next = limit(est.amountOut === 0n ? amountIn * 2n : ceilDiv(amountIn * wanted, est.amountOut) + 1n);
    if (next <= amountIn) break;
    amountIn = next;
  }
  return best;
}

interface Plan {
  series: SeriesState;
  holdings: Holdings;
  target: bigint;
  held: bigint;
  need: bigint;
  warnings: string[];
}

const header = (p: Plan) => ({
  targetClaims: fmt(p.target, p.series.collateralDecimals),
  alreadyHeldNetLong: fmt(p.held, p.series.collateralDecimals),
  claimsToAcquire: fmt(p.need, p.series.collateralDecimals),
});

export async function hedge(deps: Deps, input: HedgeInput): Promise<HedgeResult> {
  const { client, config, wallet } = deps;
  const owner = wallet.address;
  const series = await readSeries(client, config);
  if (series.settled || series.now >= series.periodEnd) {
    throw new PiryError(
      "SERIES_CLOSED",
      series.settled ? "The series is already settled; a new hedge cannot be bought." : "The series period has ended and is awaiting settlement; a new hedge cannot be bought.",
      "Use `mm piry position` to see the settlement state, then `mm piry redeem`.",
    );
  }

  const [holdings, kuru] = await Promise.all([readHoldings(client, config, owner), loadKuru(client, config, owner)]);
  const { longClaim, shortClaim } = config.series;
  const dec = series.collateralDecimals;
  const target = claimsForGpuHours(input.gpuHoursMicro, series.band, dec);
  if (target === 0n) throw new PiryError("HEDGE_TOO_SMALL", "That many GPU-hours rounds down to zero claims.", "Use a larger --gpu-hours.");

  const heldLong = holdings.long + balanceOf(kuru.account, longClaim).free;
  const heldShort = holdings.short + balanceOf(kuru.account, shortClaim).free;
  const held = netLong(heldLong, heldShort);
  const need = target > held ? target - held : 0n;
  const warnings: string[] = [];
  if (heldShort > 0n) warnings.push(`You hold ${fmt(heldShort, dec)} PIRY-S, which cancels the same amount of PIRY-L; only the net long position counts toward the hedge.`);
  const plan: Plan = { series, holdings, target, held, need, warnings };

  if (need === 0n) {
    return { ...header(plan), status: "ALREADY_HEDGED", path: "none", executed: false, plan: {}, steps: [], warnings, next: "Nothing to buy: your net long claims already cover this many GPU-hours." };
  }

  const market = kuru.market;
  const sizing = market && market.bestAskRaw !== null
    ? await sizeBuy((amountIn) => estimateSwap(client, market.address, true, amountIn, kuru.account.rootId), need, askCost(need, market.bestAskRaw, market), input.maxPremium)
    : null;
  if (market && sizing && sizing.expectedOut > 0n) return hedgeOnKuru(deps, input, plan, kuru, market, sizing);

  const why = market ? "The Kuru market has no asks to buy from." : "No Kuru market is configured for PIRY-L yet.";
  if (!input.allowMint) {
    return {
      ...header(plan), status: "UNAVAILABLE", path: "none", executed: false,
      plan: { mintAlternative: `${fmt(need, dec)} USDC of collateral would mint ${fmt(need, dec)} PIRY-L and PIRY-S pairs` },
      steps: [], warnings: [why, ...warnings],
      next: "Wait for the Kuru listing, or re-run with --allow-mint to lock collateral and mint pairs (the PIRY-S leg stays unsold unless --short-to is given).",
    };
  }
  return hedgeByMint(deps, input, { ...plan, warnings: [why, ...warnings] }, kuru);
}

async function hedgeOnKuru(deps: Deps, input: HedgeInput, p: Plan, kuru: KuruView, market: KuruMarket, sizing: BuySizing): Promise<HedgeResult> {
  const { client, config, wallet } = deps;
  const { collateral, longClaim, shortClaim } = config.series;
  const owner = wallet.address;
  const dec = p.series.collateralDecimals;
  const qd = market.quoteDecimals;
  const { amountIn, expectedOut } = sizing;
  const minOut = slippageFloor(expectedOut, input.slippageBps);
  const warnings = [...p.warnings];
  if (!sizing.complete) warnings.push(`Only ${fmt(expectedOut, dec)} of ${fmt(p.need, dec)} claims fit ${input.maxPremium === null ? "the order book depth" : "under the cap or the book depth"}; the hedge will be partial.`);
  if (amountIn < market.minQuote) warnings.push(`The order is below the market's minimum notional of ${fmt(market.minQuote, qd)} USDC and may revert.`);

  const plan = {
    spendUsdc: fmt(amountIn, qd),
    expectedClaims: fmt(expectedOut, dec),
    minClaims: fmt(minOut, dec),
    averagePriceUsdc: fmt((amountIn * 10n ** BigInt(dec)) / expectedOut, qd),
    slippageBps: String(input.slippageBps),
    maxPremiumUsdc: input.maxPremium === null ? "none (preview only)" : fmt(input.maxPremium, qd),
    market: market.address,
  };
  if (input.maxPremium === null) {
    return { ...header(p), status: "PREVIEW", path: "kuru", executed: false, plan, steps: [], warnings, next: "Nothing was sent. Re-run with --max-premium <USDC> (the most you will pay) to execute." };
  }

  const run = new Run(wallet, new Budget(input.maxPremium), deps.note);
  run.budget.check(amountIn, "purchase");
  const quoteFree = balanceOf(kuru.account, collateral).free;
  const toDeposit = amountIn > quoteFree ? amountIn - quoteFree : 0n;
  if (toDeposit > p.holdings.collateral) {
    throw new PiryError("INSUFFICIENT_BALANCE", `Need ${fmt(toDeposit, dec)} USDC in the wallet, have ${fmt(p.holdings.collateral, dec)}.`, "Fund the Agent Wallet with Kuru test USDC on Monad testnet. Nothing was sent.");
  }

  if (toDeposit > 0n) {
    if ((await readAllowance(client, collateral, owner, config.accountCore)) < toDeposit) {
      await run.send("approve", `Piry: let Kuru take ${fmt(toDeposit, dec)} USDC for the PIRY-L purchase`, approveTx(collateral, config.accountCore, toDeposit));
    }
    await run.send("deposit", `Piry: deposit ${fmt(toDeposit, dec)} USDC into your Kuru trading balance`, depositTx(config.accountCore, owner, collateral, toDeposit));
  }

  const account = await readAccount(client, config.accountCore, owner, [longClaim]);
  if (account.rootId === 0n) throw new PiryError("KURU_ACCOUNT_MISSING", "No Kuru account exists for this wallet after the deposit.", "Run `mm piry position` and check the deposit transaction before retrying.");
  await run.send(
    "swap",
    `Piry: buy at least ${fmt(minOut, dec)} PIRY-L for up to ${fmt(amountIn, qd)} USDC on Kuru`,
    swapTx(market.address, account.rootId, true, amountIn, minOut, p.series.now + SWAP_DEADLINE_SECONDS),
    amountIn,
  );

  const received = balanceOf(await readAccount(client, config.accountCore, owner, [longClaim]), longClaim).free;
  if (received > 0n) {
    await run.send("withdraw", `Piry: withdraw ${fmt(received, dec)} PIRY-L from Kuru to your wallet`, withdrawTx(config.accountCore, account.rootId, longClaim, received, owner));
  }

  const [holdings, after] = await Promise.all([readHoldings(client, config, owner), loadKuru(client, config, owner)]);
  const long = holdings.long + balanceOf(after.account, longClaim).free;
  const short = holdings.short + balanceOf(after.account, shortClaim).free;
  const net = netLong(long, short);
  const full = net >= p.target;
  return {
    ...header(p),
    status: full ? "HEDGED" : "PARTIAL",
    path: "kuru",
    executed: true,
    plan,
    after: { claimsLong: fmt(long, dec), claimsShort: fmt(short, dec), netLong: fmt(net, dec), spentUsdc: fmt(run.budget.spent, qd) },
    steps: run.steps,
    warnings,
    next: full ? "Hedge in place. Check `mm piry position`; after settlement run `mm piry redeem`." : "Partial hedge. Re-run the same command to top up toward the target.",
  };
}

// Without a PIRY-L listing the only source of PIRY-L is minting pairs, which locks one collateral unit per pair.
// The hedge is active only once the PIRY-S leg is gone: it is sold on the PIRY-S Kuru market when one is configured,
// sent to --short-to, or else reported as still held.
async function hedgeByMint(deps: Deps, input: HedgeInput, p: Plan, kuru: KuruView): Promise<HedgeResult> {
  const { client, config, wallet } = deps;
  const { collateral, market, shortClaim } = config.series;
  const owner = wallet.address;
  const dec = p.series.collateralDecimals;
  const warnings = [...p.warnings];
  let quantity = input.maxPremium === null || input.maxPremium >= p.need ? p.need : input.maxPremium;
  if (quantity < p.need) warnings.push(`The cap only covers minting ${fmt(quantity, dec)} of ${fmt(p.need, dec)} pairs; the hedge will be partial.`);

  const shortMarket = input.shortTo ? null : kuru.shortMarket;
  let sale: SalePlan | null = null;
  if (shortMarket && quantity > 0n) {
    sale = await planSale(deps, shortMarket, kuru.account.rootId, quantity, input.slippageBps, null, dec);
    if (sale.amount < quantity) {
      warnings.push(`The PIRY-S book can only absorb ${fmt(sale.amount, dec)} of ${fmt(quantity, dec)}; minting is limited to what can be sold.`);
      quantity = sale.amount;
      sale = quantity > 0n ? { ...sale, amount: quantity } : null;
    }
  }
  warnings.push("Minting locks 1 USDC of collateral per claim pair; the PIRY-S sale proceeds come back, the rest is recoverable by merging the pair or after settlement.");

  const plan: Record<string, string> = {
    collateralLockedUsdc: fmt(quantity, dec),
    pairsMinted: fmt(quantity, dec),
    shortLeg: input.shortTo ? `sent to ${input.shortTo}` : sale ? `sold on Kuru ${shortMarket!.address} for about ${fmt(sale.expected, dec)} USDC (floor ${fmt(sale.minOut, dec)})` : "kept in your wallet (hedge not active)",
    netCostAfterShortSaleUsdc: sale ? fmt(quantity - sale.expected, dec) : fmt(quantity, dec),
    maxPremiumUsdc: input.maxPremium === null ? "none (preview only)" : fmt(input.maxPremium, dec),
  };
  if (input.maxPremium === null) {
    return { ...header(p), status: "PREVIEW", path: "mint", executed: false, plan, steps: [], warnings, next: "Nothing was sent. Re-run with --max-premium <USDC> at least equal to the collateral to lock." };
  }
  if (quantity === 0n) throw new PiryError("CAP_EXCEEDED", "Nothing can be minted within the cap and the PIRY-S book depth.", "Pass a larger --max-premium or wait for liquidity.");

  const run = new Run(wallet, new Budget(input.maxPremium), deps.note);
  run.budget.check(quantity, "mint");
  if (quantity > p.holdings.collateral) {
    throw new PiryError("INSUFFICIENT_BALANCE", `Need ${fmt(quantity, dec)} USDC in the wallet, have ${fmt(p.holdings.collateral, dec)}.`, "Fund the Agent Wallet with Kuru test USDC on Monad testnet. Nothing was sent.");
  }
  if ((await readAllowance(client, collateral, owner, market)) < quantity) {
    await run.send("approve", `Piry: let the Piry market take ${fmt(quantity, dec)} USDC as collateral`, approveTx(collateral, market, quantity));
  }
  await run.send("mint", `Piry: lock ${fmt(quantity, dec)} USDC to mint ${fmt(quantity, dec)} PIRY-L and PIRY-S`, mintPairsTx(market, quantity), quantity);
  let proceeds = 0n;
  if (input.shortTo) {
    await run.send("transfer-short", `Piry: send ${fmt(quantity, dec)} PIRY-S to ${input.shortTo}`, transferTx(shortClaim, input.shortTo, quantity));
  } else if (shortMarket && sale) {
    proceeds = await executeSale(deps, run, shortMarket, shortClaim, "PIRY-S", sale, p.series.now, dec, quantity);
  }

  const holdings = await readHoldings(client, config, owner);
  const net = netLong(holdings.long, holdings.short);
  const active = net > 0n;
  return {
    ...header(p),
    status: !active ? "UNHEDGED_PAIR" : net >= p.target ? "HEDGED" : "PARTIAL",
    path: "mint",
    executed: true,
    plan,
    after: { claimsLong: fmt(holdings.long, dec), claimsShort: fmt(holdings.short, dec), netLong: fmt(net, dec), spentUsdc: fmt(quantity - proceeds, dec) },
    steps: run.steps,
    warnings,
    next: active
      ? "PIRY-L is held and the PIRY-S leg is gone. Check `mm piry position`; after settlement run `mm piry redeem`."
      : "Both legs are held, so net exposure is flat and the hedge is NOT active. Send or sell the PIRY-S leg to activate it, or run `mm piry unwind` to merge the pair and recover the collateral.",
  };
}
