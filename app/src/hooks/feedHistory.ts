import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import type { SeriesSubject } from "../config/types";
import { attachLogs, readFeedRounds, scanMarkUpdates, type FeedPoint } from "../lib/feedHistory";
import { logSources, withLogFallback } from "../lib/logsClient";
import { useClient, useSeriesMark, useSeriesMarket } from "./chain";

const MAX_ROUNDS = 400;
const MAX_SCAN_REQUESTS = 30;

export interface FeedHistory {
  points: FeedPoint[];
  settled: boolean;
  scanVia: string | null;
}

// The feed's rounds come from its own state (one multicall) so the chart paints quickly. The MarkUpdated events, which
// carry the block and transaction, are scanned separately and attached when they arrive. Once the market has settled
// the feed's final value is appended as the last point.
export function useFeedHistory(subject: SeriesSubject) {
  const pc = useClient();
  const market = useSeriesMarket(subject).data;
  const mark = useSeriesMark(subject).data;
  const feed = subject.contracts.markFeed;
  const latestRound = mark?.status === "ok" ? (mark.isFinal ? mark.roundId - 1n : mark.roundId) : 0n;
  const priceDecimals = market?.terms.priceDecimals ?? 6;
  const latestBlock = market?.block.number;
  const finalMark = mark?.status === "ok" && mark.isFinal ? mark : null;

  const rounds = useQuery({
    queryKey: ["feed-rounds", feed, latestRound.toString()],
    queryFn: () => readFeedRounds(pc, feed as Address, latestRound, priceDecimals, MAX_ROUNDS),
    enabled: feed !== null && latestRound > 0n && market !== undefined,
    staleTime: 30_000,
    retry: 1,
  });

  const logs = useQuery({
    queryKey: ["feed-logs", feed, latestRound.toString()],
    queryFn: () =>
      withLogFallback(logSources(pc), (source) => scanMarkUpdates(source, feed as Address, BigInt(subject.deployBlock ?? 0), latestBlock as bigint, MAX_SCAN_REQUESTS)).then(
        ({ result, source }) => ({ logs: result.logs, via: source.name }),
      ),
    enabled: rounds.isSuccess && latestBlock !== undefined,
    staleTime: 60_000,
    retry: false,
  });

  const history = useMemo<FeedHistory | undefined>(() => {
    if (!rounds.data) return undefined;
    let points = logs.data ? attachLogs(rounds.data, logs.data.logs) : rounds.data;
    if (finalMark) {
      const last = points.at(-1);
      points = [
        ...points,
        {
          round: finalMark.roundId,
          t: Number(finalMark.updatedAt),
          index: last ? last.index : 0,
          long: Number(finalMark.answer) / 1e8,
          short: 1 - Number(finalMark.answer) / 1e8,
          evidenceHash: null,
          block: null,
          tx: null,
          final: true,
          held: false,
        },
      ];
    }
    return { points, settled: market?.state.settled === true, scanVia: logs.data?.via ?? null };
  }, [rounds.data, logs.data, finalMark, market?.state.settled]);

  return { data: history, isLoading: rounds.isLoading || (rounds.isPending && feed !== null && mark === undefined), isError: rounds.isError };
}
