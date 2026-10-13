import { accountCoreAbi, orderBookAbi } from "@toxicflow-labs/ts-sdk/abi";
import { decodeFunctionData, erc20Abi, type Abi, type Address, type Hex } from "viem";
import { marketAbi, type Reader } from "../src/chain.js";
import { resolveConfig, SERIES, KURU_ACCOUNT_CORE, type Config } from "../src/config.js";
import type { Intent, TxReceipt, TxRequest, Wallet } from "../src/tx.js";

export const OWNER: Address = "0x1111111111111111111111111111111111111111";
export const LONG_MARKET: Address = "0x2222222222222222222222222222222222222222";
export const SHORT_MARKET: Address = "0x3333333333333333333333333333333333333333";
const low = (a: string) => a.toLowerCase();

export interface Book {
  base: Address;
  price: bigint; // raw price in pricePrecision units, used for both sides
  depth: bigint; // base atoms available
}

export const PRICE_PRECISION = 10_000n;

export class Sim {
  now = 1_791_900_000n;
  periodEnd = 1_792_411_200n;
  settled = false;
  settlementPrice = 0n;
  fallback = false;
  markAnswer = 45_425_000n;
  indexPrice = 3_408_500n;
  chainId = 10143;
  bal: Record<string, bigint> = { usdc: 1_000_000_000n, long: 0n, short: 0n };
  allowance = new Map<string, bigint>();
  kuruRoot = 0n;
  kuruBal: Record<string, bigint> = { usdc: 0n, long: 0n, short: 0n };
  books = new Map<string, Book>();
  sent: { tx: TxRequest; intent: Intent; fn: string; args: readonly unknown[] }[] = [];
  failOn: string | null = null;
  failWith = "boom";
  previewOffset = 0n;
  markAge = 200n;

  constructor() {
    this.books.set(low(LONG_MARKET), { base: SERIES.longClaim, price: 4_500n, depth: 10_000_000_000n });
    this.books.set(low(SHORT_MARKET), { base: SERIES.shortClaim, price: 5_500n, depth: 10_000_000_000n });
  }

  config(over: { long?: boolean; short?: boolean } = {}): Config {
    return resolveConfig({ kuruMarket: over.long ? LONG_MARKET : undefined, kuruShortMarket: over.short ? SHORT_MARKET : undefined });
  }

  private key = (a: Address) => (low(a) === low(SERIES.collateral) ? "usdc" : low(a) === low(SERIES.longClaim) ? "long" : "short");
  private isToken = (a: string) => [SERIES.collateral, SERIES.longClaim, SERIES.shortClaim].some((t) => low(t) === low(a));

  private est(market: string, isBuy: boolean, amountIn: bigint) {
    const book = this.books.get(low(market))!;
    // buy: quote in, base out; sell: base in, quote out. Quote and base both have 6 decimals here.
    const out = isBuy ? (amountIn * PRICE_PRECISION) / book.price : (amountIn * book.price) / PRICE_PRECISION;
    const baseMoved = isBuy ? out : amountIn;
    if (baseMoved <= book.depth) return { amountInUsed: amountIn, amountOut: out };
    const used = isBuy ? (book.depth * book.price) / PRICE_PRECISION : book.depth;
    return { amountInUsed: used, amountOut: isBuy ? book.depth : (book.depth * book.price) / PRICE_PRECISION };
  }

  reader: Reader = {
    getChainId: async () => this.chainId,
    getBlock: async () => ({ timestamp: this.now }) as never,
    readContract: (async (req: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const a = low(req.address);
      const args = req.args ?? [];
      const f = req.functionName;
      if (a === low(SERIES.market)) {
        const v: Record<string, unknown> = {
          collateral: SERIES.collateral, longClaim: SERIES.longClaim, shortClaim: SERIES.shortClaim, lower: 2_500_000n, upper: 4_500_000n,
          priceDecimals: 6, periodStart: 1_791_812_712n, periodEnd: this.periodEnd, fallbackDelay: 604_800n, settled: this.settled,
          settledByFallback: this.fallback, settlementPrice: this.settlementPrice,
        };
        if (f === "previewRedeem") {
          const [l, s] = args as [bigint, bigint];
          const w = 2_000_000n;
          const p = this.settlementPrice;
          const lp = p <= 2_500_000n ? 0n : p >= 4_500_000n ? l : (l * (p - 2_500_000n)) / w;
          const sp = p <= 2_500_000n ? s : p >= 4_500_000n ? 0n : (s * (4_500_000n - p)) / w;
          return lp + sp + this.previewOffset;
        }
        return v[f];
      }
      if (a === low(SERIES.markFeed)) {
        if (f === "market") return SERIES.market;
        if (f === "latestRoundData") return [74n, this.markAnswer, this.now - this.markAge, this.now - this.markAge, 74n];
        if (f === "rounds") return [this.markAnswer, this.indexPrice, this.now - this.markAge, "0x00" as Hex];
      }
      if (a === low(SERIES.shortFeed)) {
        if (f === "longFeed") return SERIES.markFeed;
        if (f === "latestRoundData") return [74n, 100_000_000n - this.markAnswer, this.now - this.markAge, this.now - this.markAge, 74n];
      }
      if (this.isToken(a)) {
        const k = this.key(req.address);
        if (f === "decimals") return 6;
        if (f === "balanceOf") return this.bal[k]!;
        if (f === "allowance") return this.allowance.get(`${k}:${low(args[0] as string)}:${low(args[1] as string)}`) ?? 0n;
      }
      if (a === low(KURU_ACCOUNT_CORE)) {
        if (f === "rootAccountIdOf") return this.kuruRoot;
        if (f === "getBalance") return this.kuruRoot === 0n ? 0n : this.kuruBal[this.key(args[1] as Address)]!;
        if (f === "getSpotReservedBalance") return 0n;
      }
      const book = this.books.get(a);
      if (book) {
        if (f === "getMarketParams") return [Number(PRICE_PRECISION), 10_000_000_000n, 1, 1_000_000n, 5_000_000_000_000n, 7000n, 4000n];
        if (f === "getL2Book") return [[0], [0n], [Number(book.price)], [book.depth / 100n]];
        if (f === "baseToken") return book.base;
        if (f === "quoteToken") return SERIES.collateral;
        if (f === "quoteTokenDecimals") return 6;
        if (f === "marketState") return 0;
        if (f === "estimateSwap") {
          const [isBuy, amountIn] = args.length === 2 ? (args as [boolean, bigint]) : [args[1] as boolean, args[2] as bigint];
          return this.est(a, isBuy, amountIn);
        }
      }
      throw new Error(`sim: unhandled read ${f} on ${req.address}`);
    }) as never,
  };

  wallet: Wallet = {
    address: OWNER,
    send: async (tx: TxRequest, intent: Intent): Promise<TxReceipt> => {
      const abi = (
        low(tx.to) === low(SERIES.market) ? marketAbi : low(tx.to) === low(KURU_ACCOUNT_CORE) ? accountCoreAbi : this.books.has(low(tx.to)) ? orderBookAbi : erc20Abi
      ) as Abi;
      const { functionName, args = [] } = decodeFunctionData({ abi, data: tx.data });
      if (this.failOn === functionName) throw new Error(this.failWith);
      this.apply(tx, functionName, args);
      this.sent.push({ tx, intent, fn: functionName, args });
      return { hash: `0x${(this.sent.length).toString(16).padStart(64, "0")}` as Hex, status: "CONFIRMED" };
    },
  };

  private apply(tx: TxRequest, fn: string, args: readonly unknown[]): void {
    const to = low(tx.to);
    const k = this.isToken(to) ? this.key(tx.to) : "";
    const take = (key: string, n: bigint) => { if (this.bal[key]! < n) throw new Error(`sim: insufficient ${key}`); this.bal[key]! -= n; };
    if (k && fn === "approve") this.allowance.set(`${k}:${low(OWNER)}:${low(args[0] as string)}`, args[1] as bigint);
    else if (k && fn === "transfer") take(k, args[1] as bigint);
    else if (to === low(SERIES.market) && fn === "mintPairs") { take("usdc", args[0] as bigint); this.bal.long! += args[0] as bigint; this.bal.short! += args[0] as bigint; }
    else if (to === low(SERIES.market) && fn === "mergePairs") { take("long", args[0] as bigint); take("short", args[0] as bigint); this.bal.usdc! += args[0] as bigint; }
    else if (to === low(SERIES.market) && fn === "redeem") {
      const [l, s, , min] = args as [bigint, bigint, Address, bigint];
      const payout = this.preview(l, s);
      if (payout < min) throw new Error("MinimumPayoutNotMet");
      take("long", l); take("short", s); this.bal.usdc! += payout;
    } else if (to === low(KURU_ACCOUNT_CORE) && fn === "deposit") {
      const key = this.key(args[1] as Address);
      take(key, args[2] as bigint);
      if (this.kuruRoot === 0n) this.kuruRoot = 7n;
      this.kuruBal[key]! += args[2] as bigint;
    } else if (to === low(KURU_ACCOUNT_CORE) && fn === "withdraw") {
      const key = this.key(args[1] as Address);
      if (this.kuruBal[key]! < (args[2] as bigint)) throw new Error("sim: kuru balance");
      this.kuruBal[key]! -= args[2] as bigint; this.bal[key]! += args[2] as bigint;
    } else if (this.books.has(to) && fn === "swap") {
      const [, isBuy, amountIn, minOut] = args as [bigint, boolean, bigint, bigint, bigint];
      const book = this.books.get(to)!;
      const baseKey = this.key(book.base);
      const est = this.est(to, isBuy, amountIn);
      if (est.amountOut < minOut) throw new Error("sim: below minAmountOut");
      if (isBuy) { this.kuruBal.usdc! -= est.amountInUsed; this.kuruBal[baseKey]! += est.amountOut; }
      else { this.kuruBal[baseKey]! -= est.amountInUsed; this.kuruBal.usdc! += est.amountOut; }
    } else throw new Error(`sim: unhandled write ${fn}`);
  }

  private preview(l: bigint, s: bigint): bigint {
    const p = this.settlementPrice;
    const lp = p <= 2_500_000n ? 0n : p >= 4_500_000n ? l : (l * (p - 2_500_000n)) / 2_000_000n;
    const sp = p <= 2_500_000n ? s : p >= 4_500_000n ? 0n : (s * (4_500_000n - p)) / 2_000_000n;
    return lp + sp;
  }
}
