import { accountCoreAbi, orderBookAbi } from "@toxicflow-labs/ts-sdk/abi";
import { buildDepositToOwnerRequest, buildWithdrawRequest } from "@toxicflow-labs/ts-sdk/account";
import { buildSwapRequest } from "@toxicflow-labs/ts-sdk/spot";
import { encodeFunctionData, erc20Abi, type Abi, type Address } from "viem";
import { call, type Reader } from "./chain.js";
import type { TxRequest } from "./tx.js";

export interface KuruMarket {
  address: Address;
  baseToken: Address;
  quoteToken: Address;
  state: number;
  pricePrecision: bigint;
  minQuote: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  bestAskRaw: bigint | null;
}

export async function readMarket(client: Reader, market: Address): Promise<KuruMarket> {
  const read = <T>(fn: string, args: readonly unknown[] = []) => call<T>(client, market, orderBookAbi as Abi, fn, args);
  const [params, book, baseToken, quoteToken, quoteDecimals, state] = await Promise.all([
    read<readonly [number, bigint, number, bigint, bigint, bigint, bigint]>("getMarketParams"),
    read<readonly [readonly number[], readonly bigint[], readonly number[], readonly bigint[]]>("getL2Book", [8n]),
    read<Address>("baseToken"),
    read<Address>("quoteToken"),
    read<number>("quoteTokenDecimals"),
    read<number>("marketState"),
  ]);
  const baseDecimals = await call<number>(client, baseToken, erc20Abi, "decimals");
  const [, , askPrices, askSizes] = book;
  const asks = askPrices.map((price, i) => ({ price: BigInt(price), size: BigInt(askSizes[i] ?? 0) })).filter((l) => l.price > 0n && l.size > 0n);
  const bestAskRaw = asks.length === 0 ? null : asks.reduce((min, l) => (l.price < min ? l.price : min), asks[0]!.price);
  return {
    address: market,
    baseToken,
    quoteToken,
    state: Number(state),
    pricePrecision: BigInt(params[0]),
    minQuote: BigInt(params[3]),
    baseDecimals,
    quoteDecimals: Number(quoteDecimals),
    bestAskRaw,
  };
}

// Facts the market states about itself, compared with what the plugin expects. Any entry means: do not trade here.
export function marketIssues(market: KuruMarket, expected: { base: Address; quote: Address }): string[] {
  const issues: string[] = [];
  if (market.baseToken.toLowerCase() !== expected.base.toLowerCase()) issues.push(`its base token is ${market.baseToken}, not the PIRY-L claim ${expected.base}`);
  if (market.quoteToken.toLowerCase() !== expected.quote.toLowerCase()) issues.push(`its quote token is ${market.quoteToken}, not ${expected.quote}`);
  if (market.state !== 0) issues.push(`its market state is ${market.state}, not active (0)`);
  return issues;
}

export interface SwapEstimate {
  amountInUsed: bigint;
  amountOut: bigint;
}

export async function estimateSwap(client: Reader, market: Address, isBuy: boolean, amountIn: bigint, rootId: bigint): Promise<SwapEstimate> {
  const args = rootId === 0n ? [isBuy, amountIn] : [Number(rootId), isBuy, amountIn];
  const result = await call<{ amountInUsed: bigint; amountOut: bigint }>(client, market, orderBookAbi as Abi, "estimateSwap", args);
  return { amountInUsed: result.amountInUsed, amountOut: result.amountOut };
}

export interface KuruBalance {
  free: bigint;
  reserved: bigint;
}

export interface KuruAccount {
  rootId: bigint;
  balances: Record<string, KuruBalance>;
}

export async function readAccount(client: Reader, accountCore: Address, owner: Address, tokens: readonly Address[]): Promise<KuruAccount> {
  const rootId = BigInt(await call<number | bigint>(client, accountCore, accountCoreAbi as Abi, "rootAccountIdOf", [owner]));
  const balances: Record<string, KuruBalance> = {};
  await Promise.all(
    tokens.map(async (token) => {
      if (rootId === 0n) {
        balances[token.toLowerCase()] = { free: 0n, reserved: 0n };
        return;
      }
      const [free, reserved] = await Promise.all([
        call<bigint>(client, accountCore, accountCoreAbi as Abi, "getBalance", [Number(rootId), token]),
        call<bigint>(client, accountCore, accountCoreAbi as Abi, "getSpotReservedBalance", [Number(rootId), token]),
      ]);
      balances[token.toLowerCase()] = { free, reserved };
    }),
  );
  return { rootId, balances };
}

export const balanceOf = (account: KuruAccount, token: Address): KuruBalance => account.balances[token.toLowerCase()] ?? { free: 0n, reserved: 0n };

type SdkRequest = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
const encode = (request: SdkRequest): TxRequest => ({
  to: request.address,
  data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never),
});

export const depositTx = (accountCore: Address, owner: Address, token: Address, amount: bigint): TxRequest =>
  encode(buildDepositToOwnerRequest({ accountCore, rootOwner: owner, token, amount }) as unknown as SdkRequest);

export const withdrawTx = (accountCore: Address, rootId: bigint, token: Address, amount: bigint, recipient: Address): TxRequest =>
  encode(buildWithdrawRequest({ accountCore, rootAccountId: rootId, token, amount, recipient }) as unknown as SdkRequest);

export const swapTx = (market: Address, rootId: bigint, isBuy: boolean, amountIn: bigint, minAmountOut: bigint, deadline: bigint): TxRequest =>
  encode(buildSwapRequest({ market, userId: rootId, isBuy, amountIn, minAmountOut, deadline }) as unknown as SdkRequest);
