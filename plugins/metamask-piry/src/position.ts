import type { Address } from "viem";
import { previewRedeemOnchain, readHoldings, readSeries, type Reader } from "./chain.js";
import type { Config } from "./config.js";
import { balanceOf, readAccount } from "./kuru.js";
import { fmt, netLong, valueAtMark } from "./math.js";
import { countdown } from "./redeem.js";

// Kuru's withdrawal limiter rejects prices older than 1800 s; stay well inside that.
export const MARK_STALE_SECONDS = 1_500n;
const ONE = 100_000_000n;

export const isoTime = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

export interface PositionResult {
  owner: Address;
  series: {
    status: "OPEN" | "AWAITING_SETTLEMENT" | "SETTLED" | "SETTLED_BY_FALLBACK";
    periodEnd: string;
    timeLeft: string;
    settlementIndexUsd: string | null;
    latestIndexUsd: string | null;
    markAgeSeconds: string | null;
  };
  claims: { longWallet: string; longKuru: string; shortWallet: string; shortKuru: string; netLong: string; coveredGpuHours: string };
  usdc: { wallet: string; kuruTrading: string };
  valueUsdc: { markPerLongClaim: string | null; longAtMark: string | null; shortAtMark: string | null; redeemableNow: string | null };
  warnings: string[];
}

export async function position(client: Reader, config: Config, owner: Address): Promise<PositionResult> {
  const { collateral, longClaim, shortClaim } = config.series;
  const [series, holdings, kuru] = await Promise.all([
    readSeries(client, config),
    readHoldings(client, config, owner),
    readAccount(client, config.accountCore, owner, [collateral, longClaim, shortClaim]),
  ]);
  const dec = series.collateralDecimals;
  const pd = series.band.priceDecimals;
  const kuruLong = balanceOf(kuru, longClaim);
  const kuruShort = balanceOf(kuru, shortClaim);
  const longTotal = holdings.long + kuruLong.free;
  const shortTotal = holdings.short + kuruShort.free;
  const net = netLong(longTotal, shortTotal);
  const width = series.band.upper - series.band.lower;
  const warnings: string[] = [];
  if (kuruLong.reserved > 0n || kuruShort.reserved > 0n) warnings.push("Some claims are reserved by open Kuru orders and are not counted above.");

  const status = series.settled ? (series.settledByFallback ? "SETTLED_BY_FALLBACK" : "SETTLED") : series.now >= series.periodEnd ? "AWAITING_SETTLEMENT" : "OPEN";
  const mark = series.mark;
  const age = mark ? series.now - mark.updatedAt : null;
  if (!series.settled && age !== null && age > MARK_STALE_SECONDS) warnings.push(`The mark feed was last updated ${countdown(age)} ago; values may be stale.`);
  if (!series.settled && mark === null) warnings.push("The mark feed has no price yet.");

  const redeemableNow = series.settled && (longTotal > 0n || shortTotal > 0n) ? await previewRedeemOnchain(client, config, longTotal, shortTotal) : null;
  return {
    owner,
    series: {
      status,
      periodEnd: new Date(Number(series.periodEnd) * 1000).toISOString(),
      timeLeft: series.now >= series.periodEnd ? "period ended" : countdown(series.periodEnd - series.now),
      settlementIndexUsd: series.settled ? fmt(series.settlementPrice, pd) : null,
      latestIndexUsd: mark ? fmt(mark.indexPrice, pd) : null,
      markAgeSeconds: age === null ? null : age.toString(),
    },
    claims: {
      longWallet: fmt(holdings.long, dec),
      longKuru: fmt(kuruLong.free, dec),
      shortWallet: fmt(holdings.short, dec),
      shortKuru: fmt(kuruShort.free, dec),
      netLong: fmt(net, dec),
      coveredGpuHours: fmt((net * 10n ** BigInt(pd) * 10n ** 6n) / (width * 10n ** BigInt(dec)), 6),
    },
    usdc: { wallet: fmt(holdings.collateral, dec), kuruTrading: fmt(balanceOf(kuru, collateral).free, dec) },
    valueUsdc: {
      markPerLongClaim: mark ? fmt((mark.answer * 10n ** BigInt(dec)) / ONE, dec) : null,
      longAtMark: mark ? fmt(valueAtMark(longTotal, mark.answer), dec) : null,
      shortAtMark: mark ? fmt(valueAtMark(shortTotal, mark.shortAnswer ?? ONE - mark.answer), dec) : null,
      redeemableNow: redeemableNow === null ? null : fmt(redeemableNow, dec),
    },
    warnings,
  };
}
