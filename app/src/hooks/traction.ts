import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { config } from "../config";
import { logSources, withLogFallback } from "../lib/logsClient";
import { summarizeTraction, scanTraction, type Traction } from "../lib/traction";
import { useClient } from "./chain";
import { useKuruBook } from "./kuru";
import { liveSubject } from "./live";

const MAX_REQUESTS = 400;

export interface TractionResult {
  data: Traction | undefined;
  // Blocks actually scanned. reached above the configured start block means older history was not read.
  range: { reached: bigint; latest: bigint; start: bigint } | null;
  partial: boolean;
  via: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useTraction(): TractionResult {
  const pc = useClient();
  const market = liveSubject.contracts.market;
  const markets = [config.kuru.longMarket, config.kuru.shortMarket].filter((m): m is Address => m !== null);
  const from = BigInt(config.tractionFromBlock ?? liveSubject.deployBlock ?? 0);
  const longBook = useKuruBook("long").data;
  const shortBook = useKuruBook("short").data;

  const scan = useQuery({
    queryKey: ["traction", market, markets.join(), from.toString()],
    queryFn: async () => {
      const latest = await pc.getBlockNumber();
      const { result, source } = await withLogFallback(logSources(pc), (s) =>
        scanTraction(s, { markets, computeMarket: market as Address, fromBlock: from, toBlock: latest, maxRequests: MAX_REQUESTS }),
      );
      return { logs: result, via: source.name, partial: result.reachedBlock > from, range: { reached: result.reachedBlock, latest, start: from } };
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

  return { data, range: scan.data?.range ?? null, partial: scan.data?.partial ?? false, via: scan.data?.via ?? null, isLoading: scan.isLoading, isError: scan.isError };
}
