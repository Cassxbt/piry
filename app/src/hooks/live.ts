import { config, primarySubject } from "../config";
import type { SeriesSubject } from "../config/types";
import { medianOfValid } from "../lib/indexSources";
import type { Mark, MarketSnapshot } from "../lib/reads";
import { useSeriesMark, useSeriesMarket } from "./chain";

// The live series is the default deployment; the fast demo is the other one, when its manifest exists.
export const liveSubject: SeriesSubject = config.subjects.find((s) => s.id === null) ?? primarySubject;
export const demoSubject: SeriesSubject | null = config.subjects.find((s) => s.id === "fast-demo") ?? null;

export interface LiveSeries {
  subject: SeriesSubject;
  market: MarketSnapshot | undefined;
  marketUpdatedAt: number;
  mark: Mark | undefined;
  pd: number;
  index: bigint | null;
  indexOrigin: "feed" | "recorded" | null;
  long: bigint | null;
  longScale: bigint;
  band: { lower: bigint; upper: bigint } | null;
}

// Index and long-claim value for a series, from the feed when it has a round and from the recorded sources otherwise.
export function useSeries(subject: SeriesSubject): LiveSeries {
  const marketQuery = useSeriesMarket(subject);
  const market = marketQuery.data;
  const mark = useSeriesMark(subject).data;
  const pd = market?.terms.priceDecimals ?? 6;
  const band = market ? { lower: market.terms.lower, upper: market.terms.upper } : null;

  let index: bigint | null = null;
  let indexOrigin: LiveSeries["indexOrigin"] = null;
  if (market?.state.settled) {
    index = market.state.settlementPrice;
    indexOrigin = "feed";
  } else if (mark?.status === "ok" && mark.indexPrice !== null) {
    index = mark.indexPrice;
    indexOrigin = "feed";
  } else {
    const recorded = medianOfValid(subject.series.source.components, pd);
    if (recorded !== null) {
      index = recorded;
      indexOrigin = "recorded";
    }
  }

  let long: bigint | null = null;
  const longScale = 10n ** 8n;
  if (mark?.status === "ok") long = mark.answer;
  else if (index !== null && band) {
    const clamped = index <= band.lower ? 0n : index >= band.upper ? band.upper - band.lower : index - band.lower;
    long = (clamped * longScale) / (band.upper - band.lower);
  }
  return { subject, market, marketUpdatedAt: marketQuery.dataUpdatedAt, mark, pd, index, indexOrigin, long, longScale, band };
}

export const useLiveSeries = () => useSeries(liveSubject);
