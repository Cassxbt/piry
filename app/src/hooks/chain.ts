import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { chain, config, primarySubject } from "../config";
import type { SeriesSubject } from "../config/types";
import { readHolder, readMark, readMarket, readShortMark, type MarketSnapshot } from "../lib/reads";
import { logSources } from "../lib/logsClient";
import { findSettlement } from "../lib/settlement";
import { checkEvidence, fetchText } from "../lib/evidence";

const POLL_MS = 8_000;

export function useClient(): PublicClient {
  const client = usePublicClient({ chainId: chain.id });
  if (!client) throw new Error("No public client for the configured chain");
  return client as PublicClient;
}

export function useSeriesMarket(subject: SeriesSubject) {
  const pc = useClient();
  const address = subject.contracts.market;
  return useQuery({
    queryKey: ["market", address],
    queryFn: () => readMarket(pc, address as Address),
    enabled: address !== null,
    refetchInterval: POLL_MS,
  });
}

export const useMarket = () => useSeriesMarket(primarySubject);

export function useSeriesMark(subject: SeriesSubject) {
  const pc = useClient();
  const address = subject.contracts.markFeed;
  return useQuery({
    queryKey: ["mark", address],
    queryFn: () => readMark(pc, address as Address),
    enabled: address !== null,
    refetchInterval: POLL_MS,
  });
}

export const useMark = () => useSeriesMark(primarySubject);

export function useSeriesShortMark(subject: SeriesSubject) {
  const pc = useClient();
  const address = subject.contracts.shortFeed;
  return useQuery({
    queryKey: ["short-mark", address],
    queryFn: () => readShortMark(pc, address as Address),
    enabled: address !== null,
    refetchInterval: POLL_MS,
  });
}

export function useHolder(snapshot: MarketSnapshot | undefined, holder: Address | undefined) {
  const pc = useClient();
  return useQuery({
    queryKey: ["holder", snapshot?.address, holder],
    queryFn: () => readHolder(pc, snapshot as MarketSnapshot, holder as Address),
    enabled: snapshot !== undefined && holder !== undefined,
    refetchInterval: POLL_MS,
  });
}

export function useSettlement(snapshot: MarketSnapshot | undefined, subject: SeriesSubject) {
  const pc = useClient();
  const settled = snapshot?.state.settled ?? false;
  return useQuery({
    queryKey: ["settlement", snapshot?.address, settled],
    queryFn: () => findSettlement(pc, { evidenceBase: subject.evidenceBase, deployBlock: subject.deployBlock, chain: config.chain }, snapshot as MarketSnapshot, logSources(pc)),
    enabled: snapshot !== undefined && settled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useEvidenceFile(snapshot: MarketSnapshot | undefined, subject: SeriesSubject) {
  const settled = snapshot?.state.settled ?? false;
  return useQuery({
    queryKey: ["evidence", subject.evidenceBase, snapshot?.state.evidenceHash],
    queryFn: async () => {
      const text = await fetchText(`${subject.evidenceBase}/evidence.json`);
      if (text === null || !snapshot) return null;
      return { text, check: checkEvidence(text, { evidenceHash: snapshot.state.evidenceHash, price: snapshot.state.settlementPrice }) };
    },
    enabled: settled && !snapshot?.state.settledByFallback,
    staleTime: Infinity,
  });
}

// Chain time advances locally between polls so countdowns tick without extra RPC calls.
export function useChainNow(snapshot: MarketSnapshot | undefined, fetchedAt: number): bigint | null {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!snapshot) return null;
  return snapshot.block.timestamp + BigInt(Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)));
}

export function useBlockNumber() {
  const pc = useClient();
  return useQuery({
    queryKey: ["block-number"],
    queryFn: async () => (await pc.getBlock({ blockTag: "latest" })).number,
    refetchInterval: POLL_MS,
    retry: 1,
  });
}
