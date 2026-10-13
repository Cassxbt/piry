import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { markFeedAbi } from "../abi";
import type { LogSource } from "./logsClient";

export interface FeedPoint {
  round: bigint;
  t: number;
  index: number;
  long: number;
  short: number;
  evidenceHash: Hex | null;
  block: bigint | null;
  tx: Hex | null;
  final: boolean;
  // True for the point added at "now" so a step line runs to the right edge: the value is held, not re-observed.
  held: boolean;
}

export const ONE = 1e8;

// PiryShortFeed's rule: short = 1 - long, floored at one unit so an exchange never sees a non-positive price.
export function shortOf(longAnswer: bigint): bigint {
  if (longAnswer < 1n || longAnswer > 100_000_000n) throw new RangeError("long answer outside [1, 1e8]");
  return longAnswer === 100_000_000n ? 1n : 100_000_000n - longAnswer;
}

export const markUpdated = parseAbiItem(
  "event MarkUpdated(uint80 indexed roundId, int256 answer, uint256 indexPrice, uint64 observedAt, bytes32 evidenceHash)",
);

// Every round in the feed's own state (rounds(i)), read at one block, newest `maxRounds` only.
export async function readFeedRounds(pc: PublicClient, feed: Address, latestRound: bigint, priceDecimals: number, maxRounds: number): Promise<FeedPoint[]> {
  const blockNumber = await pc.getBlockNumber({ cacheTime: 0 });
  const ids: bigint[] = [];
  for (let i = latestRound; i > 0n && ids.length < maxRounds; i--) ids.push(i);
  const rows = await Promise.all(
    ids.map((round) => pc.readContract({ address: feed, abi: markFeedAbi, functionName: "rounds", args: [round], blockNumber })),
  );
  return rows
    .map(([answer, indexPrice, observedAt, evidenceHash], i): FeedPoint => ({
      round: ids[i] as bigint,
      t: Number(observedAt),
      index: Number(indexPrice) / 10 ** priceDecimals,
      long: Number(answer) / ONE,
      short: Number(shortOf(answer)) / ONE,
      evidenceHash,
      block: null,
      tx: null,
      final: false,
      held: false,
    }))
    .sort((a, b) => a.t - b.t);
}

export interface MarkLog {
  round: bigint;
  block: bigint;
  tx: Hex;
}

// Newest chunks first and capped, like the ReportProcessed scan. Returns where each round's MarkUpdated event is.
export async function scanMarkUpdates(
  source: LogSource,
  feed: Address,
  fromBlock: bigint,
  toBlock: bigint,
  maxRequests: number,
): Promise<{ logs: MarkLog[]; reachedBlock: bigint }> {
  const step = BigInt(source.maxRange);
  const chunks: [bigint, bigint][] = [];
  for (let to = toBlock; to >= fromBlock && chunks.length < maxRequests; to -= step) {
    chunks.push([to - step + 1n > fromBlock ? to - step + 1n : fromBlock, to]);
  }
  const found: MarkLog[] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [from, to] = chunks[next++] as [bigint, bigint];
      const logs = await source.client.getLogs({ address: feed, event: markUpdated, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (log.args.roundId !== undefined && log.transactionHash) found.push({ round: log.args.roundId, block: log.blockNumber, tx: log.transactionHash });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return { logs: found, reachedBlock: chunks.at(-1)?.[0] ?? toBlock };
}

export function attachLogs(points: FeedPoint[], logs: MarkLog[]): FeedPoint[] {
  const byRound = new Map(logs.map((l) => [l.round, l]));
  return points.map((p) => {
    const hit = byRound.get(p.round);
    return hit ? { ...p, block: hit.block, tx: hit.tx } : p;
  });
}

export const RANGES = [
  { id: "1H", label: "1H", seconds: 3600 },
  { id: "6H", label: "6H", seconds: 6 * 3600 },
  { id: "1D", label: "1D", seconds: 86400 },
  { id: "1W", label: "1W", seconds: 7 * 86400 },
  { id: "ALL", label: "ALL", seconds: Infinity },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export interface Windowed {
  points: FeedPoint[];
  start: number;
  end: number;
}

// The points inside the window, plus the value in force when it opened (carried in as a held point) and one at "now".
// A window never opens before the first round: before it there is nothing to show.
export function windowPoints(all: readonly FeedPoint[], range: RangeId, nowSeconds: number): Windowed {
  if (all.length === 0) return { points: [], start: nowSeconds, end: nowSeconds };
  const spec = RANGES.find((r) => r.id === range) ?? RANGES[4];
  const first = all[0] as FeedPoint;
  const last = all[all.length - 1] as FeedPoint;
  const end = Math.max(nowSeconds, last.t);
  const start = Math.max(first.t, end - spec.seconds);
  const inside = all.filter((p) => p.t >= start);
  const before = [...all].reverse().find((p) => p.t < start);
  const points: FeedPoint[] = [];
  if (before && (inside.length === 0 || (inside[0] as FeedPoint).t > start)) points.push({ ...before, t: start, held: true });
  points.push(...inside);
  if (end > last.t) points.push({ ...last, t: end, held: true });
  return { points, start, end };
}

export interface Change {
  delta: number;
  pct: number | null;
  direction: "up" | "down" | "flat";
}

export function changeOver(values: readonly number[], epsilon = 1e-9): Change {
  if (values.length < 2) return { delta: 0, pct: null, direction: "flat" };
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  const delta = last - first;
  const direction = Math.abs(delta) <= epsilon ? "flat" : delta > 0 ? "up" : "down";
  return { delta, pct: first !== 0 ? (delta / Math.abs(first)) * 100 : null, direction };
}
