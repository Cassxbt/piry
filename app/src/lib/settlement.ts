import { getAbiItem, parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";
import { computeMarketAbi, settlementReceiverAbi, simulationReceiverAbi } from "../abi";
import type { NetworkConfig } from "../config/types";
import { fetchText } from "./evidence";
import type { MarketSnapshot } from "./reads";
import { withLogFallback, type LogSource } from "./logsClient";

export interface SettlementRecord {
  kind: "report" | "fallback";
  txHash: Hex;
  blockNumber: bigint;
  transactionIndex: number;
  timestamp: bigint;
  sender: Address;
  to: Address | null;
  price: bigint;
  publishedAt: bigint | null;
  evidenceHash: Hex;
  receiverEvent: { name: string; address: Address } | null;
}

export type SettlementLookup =
  | { status: "found"; record: SettlementRecord }
  | { status: "not-found"; reason: string };

const settledEvent = getAbiItem({ abi: computeMarketAbi, name: "Settled" });
const fallbackEvent = getAbiItem({ abi: computeMarketAbi, name: "SettledByFallback" });
const receiverEvents = [
  getAbiItem({ abi: settlementReceiverAbi, name: "ReportAccepted" }),
  getAbiItem({ abi: simulationReceiverAbi, name: "DemoReportAccepted" }),
];

async function describe(pc: PublicClient, market: Address, txHash: Hex): Promise<SettlementRecord | null> {
  const [tx, receipt] = await Promise.all([pc.getTransaction({ hash: txHash }), pc.getTransactionReceipt({ hash: txHash })]);
  if (receipt.status !== "success") return null;
  const block = await pc.getBlock({ blockNumber: receipt.blockNumber });
  const mine = receipt.logs.filter((log) => log.address.toLowerCase() === market.toLowerCase());
  const settled = parseEventLogs({ abi: computeMarketAbi, logs: mine, eventName: ["Settled", "SettledByFallback"] })[0];
  if (!settled) return null;
  const receiver = parseEventLogs({
    abi: [...receiverEvents],
    logs: receipt.logs.filter((log) => log.address.toLowerCase() !== market.toLowerCase()),
  })[0];
  const base = {
    txHash,
    blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex,
    timestamp: block.timestamp,
    sender: tx.from,
    to: tx.to ?? null,
    receiverEvent: receiver ? { name: receiver.eventName, address: receiver.address } : null,
  };
  if (settled.eventName === "Settled") {
    return { ...base, kind: "report", price: settled.args.price, publishedAt: settled.args.publishedAt, evidenceHash: settled.args.evidenceHash };
  }
  return { ...base, kind: "fallback", price: settled.args.price, publishedAt: null, evidenceHash: "0x" as Hex };
}

// Lowest block whose timestamp is >= target.
async function firstBlockAtOrAfter(pc: PublicClient, target: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await pc.getBlock({ blockNumber: mid });
    if (block.timestamp >= target) high = mid;
    else low = mid + 1n;
  }
  return low;
}

type SettlementConfig = Pick<NetworkConfig, "evidenceBase" | "deployBlock" | "chain">;

async function scanForLog(pc: PublicClient, logs: LogSource, config: SettlementConfig, snapshot: MarketSnapshot): Promise<Log | null> {
  const latest = snapshot.block.number;
  const floor = BigInt(config.deployBlock ?? 0);
  const published = snapshot.state.reportPublishedAt;
  const start = await firstBlockAtOrAfter(pc, published, floor, latest);
  // A report settles within maxReportAge of its publication time; a fallback settles in the block it stamps.
  const windowSeconds = snapshot.state.settledByFallback ? 2n : snapshot.terms.maxReportAge + 30n;
  const end = await firstBlockAtOrAfter(pc, published + windowSeconds, start, latest);
  const step = BigInt(logs.maxRange);
  for (let from = start; from <= end; from += step) {
    const to = from + step - 1n < end ? from + step - 1n : end;
    const found = await logs.client.getLogs({
      address: snapshot.address,
      events: [settledEvent, fallbackEvent],
      fromBlock: from,
      toBlock: to,
    });
    if (found[0]) return found[0];
  }
  return null;
}

export async function findSettlement(pc: PublicClient, config: SettlementConfig, snapshot: MarketSnapshot, sources: LogSource[]): Promise<SettlementLookup> {
  if (!snapshot.state.settled) return { status: "not-found", reason: "The market has not settled." };
  const hintText = await fetchText(`${config.evidenceBase}/settlement.json`);
  if (hintText) {
    try {
      const { txHash } = JSON.parse(hintText) as { txHash?: Hex };
      if (txHash) {
        const record = await describe(pc, snapshot.address, txHash);
        if (record) return { status: "found", record };
      }
    } catch {
      /* Fall through to the log search. */
    }
  }
  try {
    const { result: log } = await withLogFallback(sources, (source) => scanForLog(pc, source, config, snapshot));
    if (log?.transactionHash) {
      const record = await describe(pc, snapshot.address, log.transactionHash);
      if (record) return { status: "found", record };
    }
    return { status: "not-found", reason: "No settlement log in the expected block window. Add the transaction hash to settlement.json." };
  } catch (error) {
    return { status: "not-found", reason: error instanceof Error ? error.message : String(error) };
  }
}
