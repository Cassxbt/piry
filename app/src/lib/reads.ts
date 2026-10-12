import { BaseError, ContractFunctionRevertedError, type Address, type Hex, type PublicClient } from "viem";
import { claimTokenAbi, computeMarketAbi, erc20Abi, markFeedAbi } from "../abi";

export interface BlockRef {
  number: bigint;
  timestamp: bigint;
}

export interface MarketSnapshot {
  address: Address;
  block: BlockRef;
  terms: {
    indexId: Hex;
    specHash: Hex;
    priceDecimals: number;
    lower: bigint;
    upper: bigint;
    periodStart: bigint;
    periodEnd: bigint;
    maxReportAge: bigint;
    fallbackDelay: bigint;
    settlementAuthority: Address;
  };
  state: {
    collateralLocked: bigint;
    settled: boolean;
    settledByFallback: boolean;
    settlementPrice: bigint;
    reportPublishedAt: bigint;
    evidenceHash: Hex;
  };
  collateral: { address: Address; symbol: string; decimals: number };
  claims: { long: Address; short: Address; decimals: number; longSymbol: string; shortSymbol: string; longSupply: bigint; shortSupply: bigint };
}

// Every field is read at one block so the page can name the block each number came from.
export async function readMarket(pc: PublicClient, market: Address): Promise<MarketSnapshot> {
  const latest = await pc.getBlock({ blockTag: "latest" });
  const blockNumber = latest.number;
  const base = { address: market, abi: computeMarketAbi, blockNumber } as const;
  const [
    collateral, settlementAuthority, indexId, specHash, priceDecimals, lower, upper, periodStart, periodEnd,
    maxReportAge, fallbackDelay, longClaim, shortClaim, collateralLocked, settled, settledByFallback,
    settlementPrice, reportPublishedAt, evidenceHash,
  ] = await Promise.all([
    pc.readContract({ ...base, functionName: "collateral" }),
    pc.readContract({ ...base, functionName: "settlementAuthority" }),
    pc.readContract({ ...base, functionName: "indexId" }),
    pc.readContract({ ...base, functionName: "specHash" }),
    pc.readContract({ ...base, functionName: "priceDecimals" }),
    pc.readContract({ ...base, functionName: "lower" }),
    pc.readContract({ ...base, functionName: "upper" }),
    pc.readContract({ ...base, functionName: "periodStart" }),
    pc.readContract({ ...base, functionName: "periodEnd" }),
    pc.readContract({ ...base, functionName: "maxReportAge" }),
    pc.readContract({ ...base, functionName: "fallbackDelay" }),
    pc.readContract({ ...base, functionName: "longClaim" }),
    pc.readContract({ ...base, functionName: "shortClaim" }),
    pc.readContract({ ...base, functionName: "collateralLocked" }),
    pc.readContract({ ...base, functionName: "settled" }),
    pc.readContract({ ...base, functionName: "settledByFallback" }),
    pc.readContract({ ...base, functionName: "settlementPrice" }),
    pc.readContract({ ...base, functionName: "reportPublishedAt" }),
    pc.readContract({ ...base, functionName: "settlementEvidenceHash" }),
  ]);

  const token = { abi: erc20Abi, blockNumber } as const;
  const claim = { abi: claimTokenAbi, blockNumber } as const;
  const [symbol, decimals, claimDecimals, longSupply, shortSupply, longSymbol, shortSymbol] = await Promise.all([
    pc.readContract({ ...token, address: collateral, functionName: "symbol" }),
    pc.readContract({ ...token, address: collateral, functionName: "decimals" }),
    pc.readContract({ ...claim, address: longClaim, functionName: "decimals" }),
    pc.readContract({ ...claim, address: longClaim, functionName: "totalSupply" }),
    pc.readContract({ ...claim, address: shortClaim, functionName: "totalSupply" }),
    pc.readContract({ ...claim, address: longClaim, functionName: "symbol" }),
    pc.readContract({ ...claim, address: shortClaim, functionName: "symbol" }),
  ]);

  return {
    address: market,
    block: { number: blockNumber, timestamp: latest.timestamp },
    terms: {
      indexId, specHash, priceDecimals, lower, upper, periodStart, periodEnd, maxReportAge, fallbackDelay,
      settlementAuthority,
    },
    state: { collateralLocked, settled, settledByFallback, settlementPrice, reportPublishedAt, evidenceHash },
    collateral: { address: collateral, symbol, decimals },
    claims: { long: longClaim, short: shortClaim, decimals: claimDecimals, longSymbol, shortSymbol, longSupply, shortSupply },
  };
}

export type Mark =
  | {
      status: "ok";
      block: bigint;
      description: string;
      isSimulation: boolean;
      decimals: number;
      roundId: bigint;
      answer: bigint;
      updatedAt: bigint;
      isFinal: boolean;
      indexPrice: bigint | null;
      evidenceHash: Hex | null;
    }
  | { status: "empty"; block: bigint; description: string; isSimulation: boolean }
  | { status: "error"; message: string };

const isNoData = (error: unknown) =>
  error instanceof BaseError &&
  error.walk((e) => e instanceof ContractFunctionRevertedError && e.data?.errorName === "NoData") !== null;

export async function readMark(pc: PublicClient, feed: Address): Promise<Mark> {
  try {
    const blockNumber = await pc.getBlockNumber({ cacheTime: 0 });
    const base = { address: feed, abi: markFeedAbi, blockNumber } as const;
    const [description, isSimulation, decimals, latestRound] = await Promise.all([
      pc.readContract({ ...base, functionName: "description" }),
      pc.readContract({ ...base, functionName: "isSimulation" }),
      pc.readContract({ ...base, functionName: "decimals" }),
      pc.readContract({ ...base, functionName: "latestRound" }),
    ]);
    let round: readonly [bigint, bigint, bigint, bigint, bigint];
    try {
      round = await pc.readContract({ ...base, functionName: "latestRoundData" });
    } catch (error) {
      if (isNoData(error)) return { status: "empty", block: blockNumber, description, isSimulation };
      throw error;
    }
    const [roundId, answer, , updatedAt] = round;
    const isFinal = roundId > latestRound;
    let indexPrice: bigint | null = null;
    let evidenceHash: Hex | null = null;
    if (!isFinal) {
      const stored = await pc.readContract({ ...base, functionName: "rounds", args: [roundId] });
      indexPrice = stored[1];
      evidenceHash = stored[3];
    }
    return { status: "ok", block: blockNumber, description, isSimulation, decimals, roundId, answer, updatedAt, isFinal, indexPrice, evidenceHash };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export interface HolderBalances {
  block: bigint;
  long: bigint;
  short: bigint;
  collateral: bigint;
  collateralAllowance: bigint;
}

export async function readHolder(pc: PublicClient, snapshot: MarketSnapshot, holder: Address): Promise<HolderBalances> {
  const blockNumber = await pc.getBlockNumber({ cacheTime: 0 });
  const [long, short, collateral, collateralAllowance] = await Promise.all([
    pc.readContract({ abi: claimTokenAbi, address: snapshot.claims.long, functionName: "balanceOf", args: [holder], blockNumber }),
    pc.readContract({ abi: claimTokenAbi, address: snapshot.claims.short, functionName: "balanceOf", args: [holder], blockNumber }),
    pc.readContract({ abi: erc20Abi, address: snapshot.collateral.address, functionName: "balanceOf", args: [holder], blockNumber }),
    pc.readContract({ abi: erc20Abi, address: snapshot.collateral.address, functionName: "allowance", args: [holder, snapshot.address], blockNumber }),
  ]);
  return { block: blockNumber, long, short, collateral, collateralAllowance };
}

export type Phase = "pre-period" | "in-period" | "awaiting-settlement" | "fallback-window" | "settled" | "settled-fallback";

// Phases follow the chain's own clock (latest block timestamp), not the viewer's.
export function phaseOf(s: MarketSnapshot): Phase {
  if (s.state.settledByFallback) return "settled-fallback";
  if (s.state.settled) return "settled";
  const now = s.block.timestamp;
  if (now < s.terms.periodStart) return "pre-period";
  if (now < s.terms.periodEnd) return "in-period";
  return now >= s.terms.periodEnd + s.terms.fallbackDelay ? "fallback-window" : "awaiting-settlement";
}
