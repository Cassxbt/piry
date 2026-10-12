import { useQuery } from "@tanstack/react-query";
import type { Address, Hex, PublicClient } from "viem";
import { markFeedAbi, simulationReceiverAbi } from "../abi";
import { chain, config } from "../config";
import { annotate, loadManifest, readDelivery, scanReportProcessed, type Delivery, type LedgerContext, type OffchainRefusal, type ScanResult } from "../lib/ledger";
import type { MarketSnapshot } from "../lib/reads";
import type { SettlementRecord } from "../lib/settlement";
import { useClient } from "./chain";

export interface LedgerData {
  deliveries: Delivery[];
  scan: ScanResult | null;
  manifestCount: number | null;
  offchain: OffchainRefusal[];
  blocked: string | null;
}

async function operatorOf(pc: PublicClient, address: Address | null, abi: typeof simulationReceiverAbi | typeof markFeedAbi): Promise<Address | null> {
  if (!address) return null;
  try {
    const operator = (await pc.readContract({ address, abi, functionName: "operator" })) as Address;
    return /^0x0{40}$/.test(operator) ? null : operator;
  } catch {
    return null;
  }
}

async function buildLedger(pc: PublicClient, snapshot: MarketSnapshot, settlement: SettlementRecord | null): Promise<LedgerData> {
  const { forwarder, receiver, markFeed } = config.contracts;
  if (!forwarder) return { deliveries: [], scan: null, manifestCount: null, offchain: [], blocked: "The deployment manifest lists no forwarder, so there is nothing to scan for ReportProcessed events." };
  const receivers = [receiver, markFeed].filter((a): a is Address => a !== null);
  if (receivers.length === 0) return { deliveries: [], scan: null, manifestCount: null, offchain: [], blocked: "No settlement receiver or mark feed is deployed." };

  const ctx: LedgerContext = { forwarder, market: snapshot.address, settlementReceiver: receiver, feed: markFeed, chainId: BigInt(chain.id) };
  const chunk = config.chain.getLogsMaxRange;
  const latest = snapshot.block.number;
  const toBlock = settlement && settlement.kind === "report" ? settlement.blockNumber + BigInt(chunk * 3) : latest;

  const [scan, manifest, settlementOp, markOp] = await Promise.all([
    scanReportProcessed(pc, {
      forwarder, receivers, fromBlock: BigInt(config.deployBlock ?? 0), toBlock: toBlock > latest ? latest : toBlock,
      chunk, maxRequests: config.chain.scanMaxRequests,
    }).catch(() => null),
    loadManifest(config.evidenceBase),
    operatorOf(pc, receiver, simulationReceiverAbi),
    operatorOf(pc, markFeed, markFeedAbi),
  ]);

  const notes = new Map<Hex, string | null>();
  for (const hash of scan?.hashes ?? []) notes.set(hash, null);
  for (const entry of manifest?.entries ?? []) notes.set(entry.txHash, entry.note);
  if (settlement && settlement.kind === "report") notes.set(settlement.txHash, notes.get(settlement.txHash) ?? null);

  const read = await Promise.all([...notes].map(([hash, note]) => readDelivery(pc, ctx, hash, note).catch(() => null)));
  const deliveries = annotate(
    read.filter((d): d is Delivery => d !== null),
    ctx,
    {
      snapshot,
      settlementAt: settlement ? { blockNumber: settlement.blockNumber, transactionIndex: settlement.transactionIndex } : null,
      operators: { settlement: settlementOp, mark: markOp },
    },
  );
  return { deliveries, scan, manifestCount: manifest ? manifest.entries.length : null, offchain: manifest?.offchain ?? [], blocked: null };
}

export function useLedger(snapshot: MarketSnapshot | undefined, settlement: SettlementRecord | null, ready: boolean) {
  const pc = useClient();
  const settled = snapshot?.state.settled ?? false;
  return useQuery({
    queryKey: ["ledger", snapshot?.address, settled, settlement?.txHash ?? null],
    queryFn: () => buildLedger(pc, snapshot as MarketSnapshot, settlement),
    enabled: snapshot !== undefined && ready,
    refetchInterval: settled ? false : 45_000,
    staleTime: settled ? Infinity : 20_000,
    retry: false,
  });
}

export interface MarkRound {
  roundId: bigint;
  answer: bigint;
  indexPrice: bigint;
  observedAt: bigint;
  evidenceHash: Hex;
}

export function useMarkRounds(latestRound: bigint | undefined) {
  const pc = useClient();
  const feed = config.contracts.markFeed;
  return useQuery({
    queryKey: ["mark-rounds", feed, latestRound?.toString()],
    queryFn: async (): Promise<MarkRound[]> => {
      const ids: bigint[] = [];
      for (let i = latestRound as bigint; i > 0n && ids.length < 8; i--) ids.push(i);
      return Promise.all(
        ids.map(async (roundId) => {
          const [answer, indexPrice, observedAt, evidenceHash] = await pc.readContract({ address: feed as Address, abi: markFeedAbi, functionName: "rounds", args: [roundId] });
          return { roundId, answer, indexPrice, observedAt, evidenceHash };
        }),
      );
    },
    enabled: feed !== null && latestRound !== undefined && latestRound > 0n,
  });
}
