import { previewRedeemOnchain, readHoldings, readSeries } from "./chain.js";
import { loadKuru, type Deps } from "./context.js";
import { PiryError } from "./errors.js";
import { balanceOf, withdrawTx } from "./kuru.js";
import { fmt, previewRedeem } from "./math.js";
import { redeemTx, Budget, Run, type StepLog } from "./tx.js";

export interface RedeemInput {
  minPayout: bigint | null;
}

export interface RedeemResult {
  executed: boolean;
  settlementPriceUsd: string;
  settledByFallback: boolean;
  redeemedLong: string;
  redeemedShort: string;
  expectedPayoutUsdc: string;
  minPayoutUsdc: string;
  receivedUsdc: string;
  steps: StepLog[];
  next: string;
}

export function countdown(seconds: bigint): string {
  if (seconds <= 0n) return "now";
  const s = Number(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export async function redeem(deps: Deps, input: RedeemInput): Promise<RedeemResult> {
  const { client, config, wallet } = deps;
  const owner = wallet.address;
  const { collateral, longClaim, shortClaim } = config.series;
  const series = await readSeries(client, config);
  const dec = series.collateralDecimals;
  if (!series.settled) {
    const fallbackAt = series.periodEnd + series.fallbackDelay;
    const waiting = series.now < series.periodEnd ? `Settlement is ${countdown(series.periodEnd - series.now)} away.` : "The period has ended and settlement has not been delivered yet.";
    throw new PiryError(
      "NOT_SETTLED",
      `The series is not settled. ${waiting}`,
      series.now >= fallbackAt
        ? "The 7-day fallback window has passed: anyone can call settleFallback() on the market to settle at the band midpoint."
        : `Try again after settlement. If no oracle report arrives, the permissionless fallback opens in ${countdown(fallbackAt - series.now)}.`,
    );
  }

  const [holdings, kuru] = await Promise.all([readHoldings(client, config, owner), loadKuru(client, config, owner)]);
  const kuruLong = balanceOf(kuru.account, longClaim).free;
  const kuruShort = balanceOf(kuru.account, shortClaim).free;
  const long = holdings.long + kuruLong;
  const short = holdings.short + kuruShort;
  if (long === 0n && short === 0n) throw new PiryError("NOTHING_TO_REDEEM", "You hold no PIRY-L or PIRY-S.", "Run `mm piry position`.");

  const payout = await previewRedeemOnchain(client, config, long, short);
  const local = previewRedeem(long, short, series.settlementPrice, series.band);
  if (payout !== local) {
    throw new PiryError("PREVIEW_MISMATCH", `The contract previews ${fmt(payout, dec)} USDC but the plugin's payout math gives ${fmt(local, dec)}.`, "Stop. The market contract differs from what this plugin expects. Nothing was sent.");
  }
  const minPayout = input.minPayout ?? payout;
  if (payout < minPayout) {
    throw new PiryError("PAYOUT_BELOW_MIN", `The payout would be ${fmt(payout, dec)} USDC, below --min-payout ${fmt(minPayout, dec)}. Nothing was sent.`, "Lower --min-payout or check `mm piry position`.");
  }

  const run = new Run(wallet, new Budget(null), deps.note);
  if (kuruLong > 0n) await run.send("withdraw-long", `Piry: withdraw ${fmt(kuruLong, dec)} PIRY-L from Kuru to redeem`, withdrawTx(config.accountCore, kuru.account.rootId, longClaim, kuruLong, owner));
  if (kuruShort > 0n) await run.send("withdraw-short", `Piry: withdraw ${fmt(kuruShort, dec)} PIRY-S from Kuru to redeem`, withdrawTx(config.accountCore, kuru.account.rootId, shortClaim, kuruShort, owner));
  await run.send(
    "redeem",
    `Piry: redeem ${fmt(long, dec)} PIRY-L and ${fmt(short, dec)} PIRY-S for at least ${fmt(minPayout, dec)} USDC`,
    redeemTx(config.series.market, long, short, owner, minPayout),
  );

  const after = await readHoldings(client, config, owner);
  const received = after.collateral > holdings.collateral ? after.collateral - holdings.collateral : 0n;
  return {
    executed: true,
    settlementPriceUsd: fmt(series.settlementPrice, series.band.priceDecimals),
    settledByFallback: series.settledByFallback,
    redeemedLong: fmt(long, dec),
    redeemedShort: fmt(short, dec),
    expectedPayoutUsdc: fmt(payout, dec),
    minPayoutUsdc: fmt(minPayout, dec),
    receivedUsdc: fmt(received, dec),
    steps: run.steps,
    next: "Redeemed. The collateral is in your wallet.",
  };
}
