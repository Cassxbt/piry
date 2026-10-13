import { readHoldings, readSeries } from "./chain.js";
import { loadKuru, newRun, type Deps } from "./context.js";
import { PiryError } from "./errors.js";
import { balanceOf, requireFreshPrice, withdrawTx } from "./kuru.js";
import { fmt } from "./math.js";
import { balancesOf, held, leftovers, owned, readBalances, recovery, type Leftover } from "./reconcile.js";
import { executeSale, planSale, type SalePlan } from "./sell.js";
import { Budget, mergePairsTx, type StepLog } from "./tx.js";

export type UnwindMethod = "auto" | "merge" | "sell";

export interface UnwindInput {
  claims: bigint | null;
  method: UnwindMethod;
  slippageBps: number;
  minProceeds: bigint | null;
}

export interface UnwindResult {
  executed: boolean;
  requestedClaims: string;
  mergedPairs: string;
  soldClaims: string;
  // Expected totals include the guaranteed merge payout (one USDC unit per pair) and the sale estimate; received is
  // the measured change in wallet + Kuru USDC.
  mergeProceedsUsdc: string;
  saleProceedsUsdc: string;
  expectedProceedsUsdc: string;
  receivedUsdc: string;
  longClaimsLeft: string;
  leftovers: Leftover[];
  recovery: string[];
  steps: StepLog[];
  warnings: string[];
  next: string;
}

const MIN = (a: bigint, b: bigint) => (a < b ? a : b);

export async function unwind(deps: Deps, input: UnwindInput): Promise<UnwindResult> {
  const { client, config, wallet } = deps;
  const owner = wallet.address;
  const { longClaim, shortClaim, market: piry } = config.series;
  const series = await readSeries(client, config);
  const dec = series.collateralDecimals;
  if (series.settled) throw new PiryError("ALREADY_SETTLED", "The series is settled; unwinding before settlement no longer applies.", "Run `mm piry redeem`.");

  const [holdings, kuru] = await Promise.all([readHoldings(client, config, owner), loadKuru(client, config, owner)]);
  const kuruLong = balanceOf(kuru.account, longClaim).free;
  const kuruShort = balanceOf(kuru.account, shortClaim).free;
  const longTotal = holdings.long + kuruLong;
  const requested = input.claims ?? longTotal;
  if (requested === 0n) throw new PiryError("NOTHING_TO_UNWIND", "You hold no PIRY-L.", "Run `mm piry position`.");
  if (requested > longTotal) throw new PiryError("INSUFFICIENT_CLAIMS", `Asked to unwind ${fmt(requested, dec)} PIRY-L but only ${fmt(longTotal, dec)} are held (wallet + Kuru).`, "Lower --claims.");

  const warnings: string[] = [];
  if (kuruShort > 0n) warnings.push("PIRY-S held inside Kuru is not merged automatically; withdraw it to the wallet first.");
  // Only wallet-held PIRY-S can be paired: mergePairs burns both legs from the caller.
  const merge = input.method === "sell" ? 0n : MIN(requested, holdings.short);
  let sell = requested - merge;
  if (input.method === "merge" && sell > 0n) {
    throw new PiryError("NOT_ENOUGH_PAIRS", `Only ${fmt(merge, dec)} complete pairs are available; ${fmt(sell, dec)} PIRY-L has no matching PIRY-S to merge with.`, "Use --method sell, or leave --method on auto.");
  }
  if (sell > 0n && !kuru.market) {
    if (input.method === "sell") throw new PiryError("KURU_UNAVAILABLE", "No Kuru market is configured for PIRY-L, so it cannot be sold.", "Set --kuru-market once Kuru lists the pair, or hold to settlement and redeem.");
    warnings.push(`${fmt(sell, dec)} PIRY-L has no pair to merge with and no Kuru market is configured to sell it; it stays held until settlement.`);
    sell = 0n;
  }

  let salePlan: SalePlan | null = null;
  if (sell > 0n && kuru.market) {
    salePlan = await planSale(deps, kuru.market, kuru.account.rootId, sell, input.slippageBps, input.minProceeds, dec, merge);
    if (salePlan.amount < sell) {
      warnings.push(`The order book can only absorb ${fmt(salePlan.amount, dec)} of ${fmt(sell, dec)} PIRY-L now; the rest stays held.`);
      sell = salePlan.amount;
    }
  }
  const kuruLongForMerge = merge > holdings.long ? merge - holdings.long : 0n;
  const kuruLongForSale = MIN(sell, kuruLong - kuruLongForMerge);
  const walletLongForSale = sell - kuruLongForSale;
  if (merge + sell === 0n) {
    return { executed: false, requestedClaims: fmt(requested, dec), mergedPairs: "0", soldClaims: "0", mergeProceedsUsdc: "0", saleProceedsUsdc: "0", expectedProceedsUsdc: "0", receivedUsdc: "0", longClaimsLeft: fmt(longTotal, dec), leftovers: [], recovery: [], steps: [], warnings, next: "Nothing could be unwound." };
  }
  // mergePairs pays exactly one collateral unit per pair, so this part of the floor is known before anything is sent.
  const expectedTotal = merge + (salePlan?.expected ?? 0n);
  if (input.minProceeds !== null && expectedTotal < input.minProceeds) {
    throw new PiryError("PROCEEDS_BELOW_MIN", `Merging ${fmt(merge, dec)} pairs returns ${fmt(merge, dec)} USDC, below the minimum of ${fmt(input.minProceeds, dec)}. Nothing was sent.`, "Lower --min-proceeds, or add a Kuru sale for the rest.");
  }

  if (kuruLongForMerge > 0n || sell > 0n) await requireFreshPrice(client, config.withdrawalLimiter, longClaim);
  const start = balancesOf(config, holdings, kuru.account);
  const run = newRun(deps, new Budget(null));
  if (kuruLongForMerge > 0n) {
    await run.send("withdraw-for-merge", `Piry: withdraw ${fmt(kuruLongForMerge, dec)} PIRY-L from Kuru to merge`, withdrawTx(config.accountCore, kuru.account.rootId, longClaim, kuruLongForMerge, owner));
  }
  if (merge > 0n) {
    await run.send("merge", `Piry: merge ${fmt(merge, dec)} PIRY-L/PIRY-S pairs back into ${fmt(merge, dec)} USDC`, mergePairsTx(piry, merge, owner));
  }

  if (sell > 0n && kuru.market && salePlan) {
    await executeSale(deps, run, kuru.market, longClaim, "PIRY-L", { ...salePlan, amount: sell }, series.now, dec, walletLongForSale);
  }

  const end = await readBalances(client, config, owner);
  const left = held(end.long);
  const gain = owned(end.usdc) - owned(start.usdc);
  return {
    executed: true,
    requestedClaims: fmt(requested, dec),
    mergedPairs: fmt(merge, dec),
    soldClaims: fmt(sell, dec),
    mergeProceedsUsdc: fmt(merge, dec),
    saleProceedsUsdc: fmt(salePlan?.expected ?? 0n, dec),
    expectedProceedsUsdc: fmt(expectedTotal, dec),
    receivedUsdc: fmt(gain > 0n ? gain : 0n, dec),
    longClaimsLeft: fmt(left, dec),
    leftovers: leftovers(end, dec),
    recovery: recovery(end, config, owner, dec),
    steps: run.steps,
    warnings,
    next: left === 0n ? "Position closed." : "Some PIRY-L remains; run `mm piry position` and preview again before another unwind.",
  };
}
