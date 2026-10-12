import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { chain, config } from "../config";
import { readHolder, readMark, readMarket, type MarketSnapshot } from "../lib/reads";
import { findSettlement } from "../lib/settlement";
import { checkEvidence, fetchText } from "../lib/evidence";

const POLL_MS = 8_000;

export function useClient(): PublicClient {
  const client = usePublicClient({ chainId: chain.id });
  if (!client) throw new Error("No public client for the configured chain");
  return client as PublicClient;
}

export function useMarket() {
  const pc = useClient();
  const address = config.contracts.market;
  return useQuery({
    queryKey: ["market", address],
    queryFn: () => readMarket(pc, address as Address),
    enabled: address !== null,
    refetchInterval: POLL_MS,
  });
}

export function useMark() {
  const pc = useClient();
  const address = config.contracts.markFeed;
  return useQuery({
    queryKey: ["mark", address],
    queryFn: () => readMark(pc, address as Address),
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

export function useSettlement(snapshot: MarketSnapshot | undefined) {
  const pc = useClient();
  const settled = snapshot?.state.settled ?? false;
  return useQuery({
    queryKey: ["settlement", snapshot?.address, settled],
    queryFn: () => findSettlement(pc, config, snapshot as MarketSnapshot),
    enabled: snapshot !== undefined && settled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useEvidenceFile(snapshot: MarketSnapshot | undefined) {
  const settled = snapshot?.state.settled ?? false;
  return useQuery({
    queryKey: ["evidence", config.evidenceBase, snapshot?.state.evidenceHash],
    queryFn: async () => {
      const text = await fetchText(`${config.evidenceBase}/evidence.json`);
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
