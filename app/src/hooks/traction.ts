import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { config } from "../config";
import { logSources, withLogFallback } from "../lib/logsClient";
import { summarizeTraction, scanTraction, type Traction, type TractionLogs } from "../lib/traction";
import { useClient } from "./chain";
import { useKuruBook } from "./kuru";
import { liveSubject } from "./live";

const MAX_REQUESTS = 1000;
// Monad's newest blocks can still be replaced before they finalize, so a resumed scan leaves them for the next pass.
const TAIL_BLOCKS = 32n;

interface ScanData {
  logs: TractionLogs;
  via: string;
  partial: boolean;
  scanning: boolean;
  range: { reached: bigint; latest: bigint; start: bigint };
}

export interface TractionResult {
  data: Traction | undefined;
  // Blocks actually scanned. reached above the configured start block means older history was not read.
  range: { reached: bigint; latest: bigint; start: bigint } | null;
  partial: boolean;
  // True while blocks are still being read: the figures and range cover what has been scanned so far.
  scanning: boolean;
  via: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useTraction(): TractionResult {
  const pc = useClient();
  const queryClient = useQueryClient();
  const market = liveSubject.contracts.market;
  const markets = [config.kuru.longMarket, config.kuru.shortMarket].filter((m): m is Address => m !== null);
  const from = BigInt(config.tractionFromBlock ?? liveSubject.deployBlock ?? 0);
  const longBook = useKuruBook("long").data;
  const shortBook = useKuruBook("short").data;

  const queryKey = ["traction", market, markets.join(), from.toString()];
  const scan = useQuery({
    queryKey,
    queryFn: async (): Promise<ScanData> => {
      const previous = queryClient.getQueryData<ScanData>(queryKey);
      // A finished scan is extended from where it stopped. Only the first scan has nothing on screen, so only it streams.
      const resume = previous && !previous.scanning ? previous : undefined;
      const latest = (await pc.getBlockNumber()) - TAIL_BLOCKS;
      const start = resume ? resume.range.latest + 1n : from;
      if (resume && latest < start) return resume;
      const { result, source } = await withLogFallback(logSources(pc), (s) =>
        scanTraction(
          s,
          { markets, computeMarket: market as Address, fromBlock: start, toBlock: latest, maxRequests: MAX_REQUESTS },
          previous
            ? undefined
            : (p) => queryClient.setQueryData<ScanData>(queryKey, { logs: p, via: s.name, partial: p.reachedBlock > from, scanning: true, range: { reached: p.reachedBlock, latest, start: from } }),
        ),
      );
      // A cap-truncated catch-up leaves a gap behind it, so it replaces the earlier scan instead of joining it.
      const contiguous = resume !== undefined && result.reachedBlock <= start;
      const logs = contiguous ? { trades: [...resume.logs.trades, ...result.trades], pairs: [...resume.logs.pairs, ...result.pairs] } : result;
      const reached = contiguous ? resume.range.reached : result.reachedBlock;
      return { logs, via: source.name, partial: reached > from, scanning: false, range: { reached, latest, start: from } };
    },
    enabled: market !== null,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  const data = useMemo(() => {
    if (!scan.data) return undefined;
    const scales: Record<string, NonNullable<typeof longBook>["scale"]> = {};
    if (longBook && config.kuru.longMarket) scales[config.kuru.longMarket.toLowerCase()] = longBook.scale;
    if (shortBook && config.kuru.shortMarket) scales[config.kuru.shortMarket.toLowerCase()] = shortBook.scale;
    return summarizeTraction(scan.data.logs, config.teamAddresses ?? [], scales);
  }, [scan.data, longBook, shortBook]);

  return { data, range: scan.data?.range ?? null, partial: scan.data?.partial ?? false, scanning: scan.data?.scanning ?? false, via: scan.data?.via ?? null, isLoading: scan.isLoading, isError: scan.isError };
}
