import { erc20Abi, parseAbi, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { CHAIN_ID, type Config } from "./config.js";
import { PiryError } from "./errors.js";
import type { Band } from "./math.js";

export type Reader = Pick<PublicClient, "readContract" | "getBlock" | "getChainId" | "waitForTransactionReceipt">;

export const marketAbi = parseAbi([
  "function collateral() view returns (address)",
  "function longClaim() view returns (address)",
  "function shortClaim() view returns (address)",
  "function lower() view returns (uint256)",
  "function upper() view returns (uint256)",
  "function priceDecimals() view returns (uint8)",
  "function periodStart() view returns (uint64)",
  "function periodEnd() view returns (uint64)",
  "function fallbackDelay() view returns (uint64)",
  "function settled() view returns (bool)",
  "function settledByFallback() view returns (bool)",
  "function settlementPrice() view returns (uint256)",
  "function previewRedeem(uint256 longAmount, uint256 shortAmount) view returns (uint256)",
  "function mintPairs(uint256 quantity)",
  "function mergePairs(uint256 quantity, address recipient)",
  "function redeem(uint256 longAmount, uint256 shortAmount, address recipient, uint256 minPayout) returns (uint256)",
]);

export const feedAbi = parseAbi([
  "function market() view returns (address)",
  "function longFeed() view returns (address)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function rounds(uint80) view returns (int256 answer, uint256 indexPrice, uint64 observedAt, bytes32 evidenceHash)",
]);

export function call<T>(client: Reader, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

export interface Mark {
  round: bigint;
  answer: bigint;
  shortAnswer: bigint | null;
  indexPrice: bigint;
  observedAt: bigint;
  updatedAt: bigint;
}

export interface SeriesState {
  now: bigint;
  band: Band;
  collateralDecimals: number;
  periodStart: bigint;
  periodEnd: bigint;
  fallbackDelay: bigint;
  settled: boolean;
  settledByFallback: boolean;
  settlementPrice: bigint;
  mark: Mark | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function readSeries(client: Reader, config: Config): Promise<SeriesState> {
  const { market, collateral, longClaim, shortClaim, markFeed, shortFeed } = config.series;
  const m = <T>(fn: string) => call<T>(client, market, marketAbi, fn);
  const [
    chainId, block, onchainCollateral, onchainLong, onchainShort, lower, upper, priceDecimals, periodStart, periodEnd,
    fallbackDelay, settled, settledByFallback, settlementPrice, feedMarket, collateralDecimals, latest, shortFeedLong, shortLatest,
  ] = await Promise.all([
    client.getChainId(),
    client.getBlock(),
    m<Address>("collateral"),
    m<Address>("longClaim"),
    m<Address>("shortClaim"),
    m<bigint>("lower"),
    m<bigint>("upper"),
    m<number>("priceDecimals"),
    m<bigint>("periodStart"),
    m<bigint>("periodEnd"),
    m<bigint>("fallbackDelay"),
    m<boolean>("settled"),
    m<boolean>("settledByFallback"),
    m<bigint>("settlementPrice"),
    call<Address>(client, markFeed, feedAbi, "market"),
    call<number>(client, collateral, erc20Abi, "decimals"),
    call<readonly [bigint, bigint, bigint, bigint, bigint]>(client, markFeed, feedAbi, "latestRoundData").catch(() => null),
    call<Address>(client, shortFeed, feedAbi, "longFeed").catch(() => null),
    call<readonly [bigint, bigint, bigint, bigint, bigint]>(client, shortFeed, feedAbi, "latestRoundData").catch(() => null),
  ]);

  if (chainId !== CHAIN_ID) {
    throw new PiryError("WRONG_CHAIN", `The RPC reports chain ${chainId}, expected Monad testnet (${CHAIN_ID}).`, "Check PIRY_RPC_URL.");
  }
  if (!same(onchainCollateral, collateral) || !same(onchainLong, longClaim) || !same(onchainShort, shortClaim) || !same(feedMarket, market)) {
    throw new PiryError(
      "SERIES_MISMATCH",
      "The configured Piry contracts do not match what the market contract reports on chain.",
      "Stop and update the plugin to the current series; do not trade against mismatched contracts.",
    );
  }

  // A short feed that does not point at our long feed would price PIRY-S off another market; ignore it.
  const shortAnswer = shortFeedLong !== null && same(shortFeedLong, markFeed) && shortLatest ? shortLatest[1] : null;

  let mark: Mark | null = null;
  if (latest) {
    const [round, answer, , updatedAt] = latest;
    // Once settled the feed serves a synthetic final round that has no stored index price.
    if (settled) {
      mark = { round, answer, shortAnswer, indexPrice: settlementPrice, observedAt: updatedAt, updatedAt };
    } else {
      const [, indexPrice, observedAt] = await call<readonly [bigint, bigint, bigint, Hex]>(client, markFeed, feedAbi, "rounds", [round]);
      mark = { round, answer, shortAnswer, indexPrice, observedAt, updatedAt };
    }
  }

  return {
    now: block.timestamp,
    band: { lower, upper, priceDecimals },
    collateralDecimals,
    periodStart,
    periodEnd,
    fallbackDelay,
    settled,
    settledByFallback,
    settlementPrice,
    mark,
  };
}

export interface Holdings {
  collateral: bigint;
  long: bigint;
  short: bigint;
}

export async function readHoldings(client: Reader, config: Config, owner: Address): Promise<Holdings> {
  const { collateral, longClaim, shortClaim } = config.series;
  const balance = (token: Address) => call<bigint>(client, token, erc20Abi, "balanceOf", [owner]);
  const [c, l, s] = await Promise.all([balance(collateral), balance(longClaim), balance(shortClaim)]);
  return { collateral: c, long: l, short: s };
}

export function readAllowance(client: Reader, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return call<bigint>(client, token, erc20Abi, "allowance", [owner, spender]);
}

export function previewRedeemOnchain(client: Reader, config: Config, longAmount: bigint, shortAmount: bigint): Promise<bigint> {
  return call<bigint>(client, config.series.market, marketAbi, "previewRedeem", [longAmount, shortAmount]);
}
