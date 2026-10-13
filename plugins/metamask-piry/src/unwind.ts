import { readHoldings, readSeries } from "./chain.js";
import { loadKuru, type Deps } from "./context.js";
import { PiryError } from "./errors.js";
import { balanceOf, requireFreshPrice, withdrawTx } from "./kuru.js";
import { fmt } from "./math.js";
import { executeSale, planSale, type SalePlan } from "./sell.js";
import { Budget, Run, mergePairsTx, type StepLog } from "./tx.js";

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
  expectedProceedsUsdc: string;
  longClaimsLeft: string;
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
    salePlan = await planSale(deps, kuru.market, kuru.account.rootId, sell, input.slippageBps, input.minProceeds, dec);
    if (salePlan.amount < sell) {
      warnings.push(`The order book can only absorb ${fmt(salePlan.amount, dec)} of ${fmt(sell, dec)} PIRY-L now; the rest stays held.`);
      sell = salePlan.amount;
    }
  }
  const kuruLongForMerge = merge > holdings.long ? merge - holdings.long : 0n;
  const kuruLongForSale = MIN(sell, kuruLong - kuruLongForMerge);
  const walletLongForSale = sell - kuruLongForSale;
  if (merge + sell === 0n) {
    return { executed: false, requestedClaims: fmt(requested, dec), mergedPairs: "0", soldClaims: "0", expectedProceedsUsdc: "0", longClaimsLeft: fmt(longTotal, dec), steps: [], warnings, next: "Nothing could be unwound." };
  }

  if (kuruLongForMerge > 0n || sell > 0n) await requireFreshPrice(client, config.withdrawalLimiter, longClaim);
  const run = new Run(wallet, new Budget(null), deps.note);
  if (kuruLongForMerge > 0n) {
    await run.send("withdraw-for-merge", `Piry: withdraw ${fmt(kuruLongForMerge, dec)} PIRY-L from Kuru to merge`, withdrawTx(config.accountCore, kuru.account.rootId, longClaim, kuruLongForMerge, owner));
  }
  if (merge > 0n) {
    await run.send("merge", `Piry: merge ${fmt(merge, dec)} PIRY-L/PIRY-S pairs back into ${fmt(merge, dec)} USDC`, mergePairsTx(piry, merge, owner));
  }

  if (sell > 0n && kuru.market && salePlan) {
    await executeSale(deps, run, kuru.market, longClaim, "PIRY-L", { ...salePlan, amount: sell }, series.now, dec, walletLongForSale);
  }

  const left = (await readHoldings(client, config, owner)).long + balanceOf((await loadKuru(client, config, owner)).account, longClaim).free;
  return {
    executed: true,
    requestedClaims: fmt(requested, dec),
    mergedPairs: fmt(merge, dec),
    soldClaims: fmt(sell, dec),
    expectedProceedsUsdc: fmt(salePlan?.expected ?? 0n, dec),
    longClaimsLeft: fmt(left, dec),
    steps: run.steps,
    warnings,
    next: left === 0n ? "Position closed." : "Some PIRY-L remains; see `mm piry position`.",
  };
}
