import { getAbiItem, parseAbiItem, type Address, type Hex } from "viem";
import { computeMarketAbi } from "../abi";
import { quoteNotional, type MarketScale } from "./kuruMath";
import type { LogSource } from "./logsClient";
import { SCAN_CONCURRENCY } from "./rateLimit";

// Kuru V2 OrderBook, from the SDK's combined ABI. One event per taker order; packedTrades holds one 64-byte record per fill.
export const tradesPacked = parseAbiItem(
  "event TradesPacked(uint40 indexed accountId, address indexed executor, bytes32 clientOrderId, uint24 effectiveTakerFeePps, address builder, uint24 builderFeePps, bytes packedTrades)",
);

const pairsMinted = getAbiItem({ abi: computeMarketAbi, name: "PairsMinted" });
const pairsMerged = getAbiItem({ abi: computeMarketAbi, name: "PairsMerged" });
const redeemed = getAbiItem({ abi: computeMarketAbi, name: "Redeemed" });

export interface Fill {
  price: bigint;
  size: bigint;
}

// First word of each 64-byte record: price is bits 168..199 and fill size bits 72..167 (the SDK's decodeTradesPacked layout).
export function decodeFills(packed: Hex): Fill[] {
  const hex = packed.slice(2);
  const fills: Fill[] = [];
  for (let offset = 0; offset + 128 <= hex.length; offset += 128) {
    const word = BigInt(`0x${hex.slice(offset, offset + 64)}`);
    fills.push({ price: (word >> 168n) & ((1n << 32n) - 1n), size: (word >> 72n) & ((1n << 96n) - 1n) });
  }
  return fills;
}

export interface TradeLog {
  market: Address;
  executor: Address;
  fills: Fill[];
}

export interface PairLog {
  kind: "minted" | "merged" | "redeemed";
  account: Address;
}

export interface TractionLogs {
  trades: TradeLog[];
  pairs: PairLog[];
}

export interface Bucket {
  trades: number;
  fills: number;
  wallets: number;
  volume: number;
  // False when a positive fill could not be priced because its market's scale was unavailable: volume is a lower bound.
  volumeComplete: boolean;
  minted: number;
  merged: number;
  redeemed: number;
}

export interface Traction {
  team: Bucket;
  unclassified: Bucket;
}

const emptyBucket = (): Bucket => ({ trades: 0, fills: 0, wallets: 0, volume: 0, volumeComplete: true, minted: 0, merged: 0, redeemed: 0 });

const isFill = (fill: Fill) => fill.price > 0n && fill.size > 0n;

// Team = any address in the configured list; unclassified = every other wallet, which is not evidence of an independent
// user. A trade is a taker order with at least one positive fill, classified by the wallet that took.
// Volume is in quote tokens (USDC), summed over fills at each fill's own price.
export function summarizeTraction(logs: TractionLogs, team: readonly Address[], scales: Record<string, MarketScale>): Traction {
  const teamSet = new Set(team.map((a) => a.toLowerCase()));
  const result: Traction = { team: emptyBucket(), unclassified: emptyBucket() };
  const wallets = { team: new Set<string>(), unclassified: new Set<string>() };
  const pick = (address: Address) => (teamSet.has(address.toLowerCase()) ? "team" : "unclassified") as keyof Traction;
  for (const trade of logs.trades) {
    const fills = trade.fills.filter(isFill);
    if (fills.length === 0) continue;
    const side = pick(trade.executor);
    const bucket = result[side];
    bucket.trades += 1;
    bucket.fills += fills.length;
    wallets[side].add(trade.executor.toLowerCase());
    const scale = scales[trade.market.toLowerCase()];
    if (!scale) {
      bucket.volumeComplete = false;
      continue;
    }
    for (const fill of fills) bucket.volume += Number(quoteNotional(fill.price, fill.size, scale)) / 10 ** scale.quoteDecimals;
  }
  for (const pair of logs.pairs) {
    const side = pick(pair.account);
    result[side][pair.kind] += 1;
    wallets[side].add(pair.account.toLowerCase());
  }
  result.team.wallets = wallets.team.size;
  result.unclassified.wallets = wallets.unclassified.size;
  return result;
}

export type TractionScan = TractionLogs & { reachedBlock: bigint };

// Newest chunks first and capped, like the other log scans; reachedBlock says how far back it got. Chunks finish out of
// order, so onProgress is given only the unbroken run of finished chunks from the newest block: every log in it, and
// no gap behind it, which keeps the reported range true.
export async function scanTraction(
  source: LogSource,
  args: { markets: Address[]; computeMarket: Address; fromBlock: bigint; toBlock: bigint; maxRequests: number },
  onProgress?: (scan: TractionScan) => void,
): Promise<TractionScan> {
  const step = BigInt(source.maxRange);
  const chunks: [bigint, bigint][] = [];
  for (let to = args.toBlock; to >= args.fromBlock && chunks.length < args.maxRequests; to -= step) {
    chunks.push([to - step + 1n > args.fromBlock ? to - step + 1n : args.fromBlock, to]);
  }
  const address = [...args.markets, args.computeMarket];
  const results: (TractionLogs | undefined)[] = chunks.map(() => undefined);
  let finished = 0;
  let next = 0;
  const gather = (count: number): TractionScan => {
    const gathered: TractionScan = { trades: [], pairs: [], reachedBlock: chunks[count - 1]?.[0] ?? args.toBlock };
    for (const part of results.slice(0, count) as TractionLogs[]) {
      gathered.trades.push(...part.trades);
      gathered.pairs.push(...part.pairs);
    }
    return gathered;
  };
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      const [fromBlock, toBlock] = chunks[index] as [bigint, bigint];
      const logs = await source.client.getLogs({ address, events: [tradesPacked, pairsMinted, pairsMerged, redeemed], fromBlock, toBlock });
      const part: TractionLogs = { trades: [], pairs: [] };
      for (const log of logs) {
        if (log.eventName === "TradesPacked") {
          if (log.args.executor && log.args.packedTrades) part.trades.push({ market: log.address, executor: log.args.executor, fills: decodeFills(log.args.packedTrades) });
          continue;
        }
        const account = (log.args as { account?: Address }).account;
        if (!account) continue;
        part.pairs.push({ kind: log.eventName === "PairsMinted" ? "minted" : log.eventName === "PairsMerged" ? "merged" : "redeemed", account });
      }
      results[index] = part;
      let frontier = finished;
      while (frontier < chunks.length && results[frontier]) frontier++;
      if (frontier > finished) {
        finished = frontier;
        onProgress?.(gather(frontier));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, chunks.length) }, worker));
  return gather(chunks.length);
}
