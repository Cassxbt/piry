import { getAbiItem, parseAbiItem, type Address, type Hex } from "viem";
import { computeMarketAbi } from "../abi";
import { quoteNotional, type MarketScale } from "./kuruMath";
import type { LogSource } from "./logsClient";

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
  minted: number;
  merged: number;
  redeemed: number;
}

export interface Traction {
  team: Bucket;
  external: Bucket;
}

const emptyBucket = (): Bucket => ({ trades: 0, fills: 0, wallets: 0, volume: 0, minted: 0, merged: 0, redeemed: 0 });

// Team = any address in the configured list; external = every other wallet. A trade is classified by the wallet that took.
// Volume is in quote tokens (USDC), summed over fills at each fill's own price.
export function summarizeTraction(logs: TractionLogs, team: readonly Address[], scales: Record<string, MarketScale>): Traction {
  const teamSet = new Set(team.map((a) => a.toLowerCase()));
  const result: Traction = { team: emptyBucket(), external: emptyBucket() };
  const wallets = { team: new Set<string>(), external: new Set<string>() };
  const pick = (address: Address) => (teamSet.has(address.toLowerCase()) ? "team" : "external") as keyof Traction;
  for (const trade of logs.trades) {
    const side = pick(trade.executor);
    const bucket = result[side];
    bucket.trades += 1;
    bucket.fills += trade.fills.length;
    wallets[side].add(trade.executor.toLowerCase());
    const scale = scales[trade.market.toLowerCase()];
    if (!scale) continue;
    for (const fill of trade.fills) bucket.volume += Number(quoteNotional(fill.price, fill.size, scale)) / 10 ** scale.quoteDecimals;
  }
  for (const pair of logs.pairs) {
    const side = pick(pair.account);
    result[side][pair.kind] += 1;
    wallets[side].add(pair.account.toLowerCase());
  }
  result.team.wallets = wallets.team.size;
  result.external.wallets = wallets.external.size;
  return result;
}

// Newest chunks first and capped, like the other log scans; reachedBlock says how far back it got.
export async function scanTraction(
  source: LogSource,
  args: { markets: Address[]; computeMarket: Address; fromBlock: bigint; toBlock: bigint; maxRequests: number },
): Promise<TractionLogs & { reachedBlock: bigint }> {
  const step = BigInt(source.maxRange);
  const chunks: [bigint, bigint][] = [];
  for (let to = args.toBlock; to >= args.fromBlock && chunks.length < args.maxRequests; to -= step) {
    chunks.push([to - step + 1n > args.fromBlock ? to - step + 1n : args.fromBlock, to]);
  }
  const trades: TradeLog[] = [];
  const pairs: PairLog[] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [fromBlock, toBlock] = chunks[next++] as [bigint, bigint];
      const [tradeLogs, pairLogs] = await Promise.all([
        args.markets.length > 0 ? source.client.getLogs({ address: args.markets, event: tradesPacked, fromBlock, toBlock }) : Promise.resolve([]),
        source.client.getLogs({ address: args.computeMarket, events: [pairsMinted, pairsMerged, redeemed], fromBlock, toBlock }),
      ]);
      for (const log of tradeLogs) {
        if (log.args.executor && log.args.packedTrades) trades.push({ market: log.address, executor: log.args.executor, fills: decodeFills(log.args.packedTrades) });
      }
      for (const log of pairLogs) {
        const account = (log.args as { account?: Address }).account;
        if (!account) continue;
        const kind = log.eventName === "PairsMinted" ? "minted" : log.eventName === "PairsMerged" ? "merged" : "redeemed";
        pairs.push({ kind, account });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return { trades, pairs, reachedBlock: chunks.at(-1)?.[0] ?? args.toBlock };
}
