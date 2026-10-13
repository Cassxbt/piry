import { readSeries, type Reader } from "./chain.js";
import type { Config } from "./config.js";
import { estimateSwap, marketIssues, readMarket } from "./kuru.js";
import { askCost, sizeBuy } from "./hedge.js";
import { claimsForGpuHours, fmt, payouts, valueAtMark } from "./math.js";
import { isoTime, MARK_STALE_SECONDS } from "./position.js";
import { countdown } from "./redeem.js";

export interface QuoteResult {
  kind: "PREVIEW";
  note: string;
  series: string;
  index: { usdPerGpuHour: string | null; observedAt: string | null; ageSeconds: string | null; stale: boolean; source: string };
  band: { lowerUsd: string; upperUsd: string };
  settlement: { status: string; at: string; timeLeft: string };
  longClaim: { markValueUsdc: string | null; meaning: string };
  hedge?: {
    gpuHours: string;
    claims: string;
    maxPayoutUsdc: string;
    fairPremiumAtMarkUsdc: string | null;
    explanation: string;
    scenarios: { indexUsd: string; billAboveFloorUsd: string; hedgePayoutUsdc: string; uncoveredUsd: string }[];
  };
  kuru: { status: string; market?: string; bestAskUsdc?: string; costToBuyHedgeUsdc?: string; claimsAtThatCost?: string; note?: string };
  warnings: string[];
}

const ONE = 100_000_000n;

export async function quote(client: Reader, config: Config, gpuHoursMicro: bigint | null): Promise<QuoteResult> {
  const series = await readSeries(client, config);
  const { band, collateralDecimals: dec, mark } = series;
  const pd = band.priceDecimals;
  const width = band.upper - band.lower;
  const warnings: string[] = [];
  const age = mark ? series.now - mark.updatedAt : null;
  const stale = !series.settled && (age === null || age > MARK_STALE_SECONDS);
  if (stale) warnings.push(age === null ? "The mark feed has no price yet." : `The mark feed was last updated ${countdown(age)} ago.`);

  const result: QuoteResult = {
    kind: "PREVIEW",
    note: "Read-only preview. `index` is the last observation the on-chain mark feed accepted (written by the Chainlink CRE workflow), not a live price; `liveSources`, when requested, is this plugin's own fetch and not an accepted observation. Nothing here is submitted.",
    series: "Piry H100 Composite (USD per GPU-hour, median of Akash, RunPod, Verda, Shadeform)",
    index: {
      usdPerGpuHour: mark ? fmt(mark.indexPrice, pd) : null,
      observedAt: mark ? isoTime(mark.observedAt) : null,
      ageSeconds: age === null ? null : age.toString(),
      stale,
      source: "on-chain mark feed written by the Chainlink CRE workflow",
    },
    band: { lowerUsd: fmt(band.lower, pd), upperUsd: fmt(band.upper, pd) },
    settlement: {
      status: series.settled ? (series.settledByFallback ? "SETTLED_BY_FALLBACK" : "SETTLED") : series.now >= series.periodEnd ? "AWAITING_SETTLEMENT" : "OPEN",
      at: isoTime(series.periodEnd),
      timeLeft: series.now >= series.periodEnd ? "period ended" : countdown(series.periodEnd - series.now),
    },
    longClaim: {
      markValueUsdc: mark ? fmt((mark.answer * 10n ** BigInt(dec)) / ONE, dec) : null,
      meaning: `One PIRY-L pays between 0 and 1 USDC at settlement: (index - ${fmt(band.lower, pd)}) / ${fmt(width, pd)}, clamped.`,
    },
    kuru: { status: "NOT_LISTED", note: "No Kuru market is configured for PIRY-L yet. Set --kuru-market or PIRY_KURU_MARKET once Kuru lists it." },
    warnings,
  };

  const claims = gpuHoursMicro === null ? null : claimsForGpuHours(gpuHoursMicro, band, dec);
  if (gpuHoursMicro !== null && claims !== null) {
    const hours = gpuHoursMicro;
    const bill = (price: bigint) => (hours * price * 10n ** BigInt(dec)) / (10n ** 6n * 10n ** BigInt(pd));
    const points = [band.lower, ...(mark ? [mark.indexPrice] : []), band.lower + width / 2n, band.upper, band.upper + width / 2n];
    result.hedge = {
      gpuHours: fmt(hours, 6),
      claims: fmt(claims, dec),
      maxPayoutUsdc: fmt(claims, dec),
      fairPremiumAtMarkUsdc: mark ? fmt(valueAtMark(claims, mark.answer), dec) : null,
      explanation:
        `Claims = GPU-hours x band width (${fmt(width, pd)} USD). The hedge offsets bill increases between ${fmt(band.lower, pd)} and ${fmt(band.upper, pd)} USD per GPU-hour. ` +
        `It pays nothing at or below ${fmt(band.lower, pd)}, so the premium is lost if the index settles there, and it stops growing at ${fmt(band.upper, pd)}: increases above that are not covered.`,
      scenarios: points.map((p) => ({
        indexUsd: fmt(p, pd),
        billAboveFloorUsd: fmt(p > band.lower ? bill(p - band.lower) : 0n, dec),
        hedgePayoutUsdc: fmt(payouts(claims, p, band).long, dec),
        uncoveredUsd: fmt(p > band.upper ? bill(p - band.upper) : 0n, dec),
      })),
    };
  }

  if (config.kuruMarket !== null) {
    try {
      const market = await readMarket(client, config.kuruMarket, config.accountCore);
      const issues = marketIssues(market, { base: config.series.longClaim, quote: config.series.collateral });
      if (issues.length > 0) {
        result.kuru = { status: "MISMATCH", market: market.address, note: `Not the PIRY-L/USDC market: ${issues.join("; ")}. Nothing will trade against it.` };
      } else if (market.bestAskRaw === null) {
        result.kuru = { status: "NO_ASKS", market: market.address, note: "The market is live but nobody is selling PIRY-L right now." };
      } else {
        const qd = market.quoteDecimals;
        result.kuru = { status: "LIVE", market: market.address, bestAskUsdc: fmt((market.bestAskRaw * 10n ** BigInt(qd)) / market.pricePrecision, qd) };
        if (claims !== null && claims > 0n) {
          const sized = await sizeBuy((amountIn) => estimateSwap(client, market.address, true, amountIn, 0n), claims, askCost(claims, market.bestAskRaw, market), null);
          result.kuru.costToBuyHedgeUsdc = fmt(sized.amountIn, qd);
          result.kuru.claimsAtThatCost = fmt(sized.expectedOut, dec);
          if (!sized.complete) warnings.push("The Kuru book is too shallow to buy the whole hedge right now.");
        }
      }
    } catch (error) {
      result.kuru = { status: "UNREADABLE", market: config.kuruMarket, note: error instanceof Error ? error.message : String(error) };
    }
  }
  return result;
}
