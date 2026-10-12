import { erc20Abi, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import { precisionDecimals, type MarketScale } from "./kuruMath";

// The SDK is large; load it only when a Kuru market is actually configured. Subpath imports keep the
// relay and websocket modules out of the bundle.
const loadSdk = (() => {
  let cached: Promise<{
    abi: typeof import("@toxicflow-labs/ts-sdk/abi");
    createAccountClient: typeof import("@toxicflow-labs/ts-sdk/account")["createAccountClient"];
    createSpotClient: typeof import("@toxicflow-labs/ts-sdk/spot")["createSpotClient"];
    events: typeof import("@toxicflow-labs/ts-sdk/events");
  }> | null = null;
  return () => {
    cached ??= Promise.all([
      import("@toxicflow-labs/ts-sdk/abi"),
      import("@toxicflow-labs/ts-sdk/account"),
      import("@toxicflow-labs/ts-sdk/spot"),
      import("@toxicflow-labs/ts-sdk/events"),
    ]).then(([abi, account, spot, events]) => ({
      abi,
      createAccountClient: account.createAccountClient,
      createSpotClient: spot.createSpotClient,
      events,
    }));
    return cached;
  };
})();

export interface BookLevel {
  priceRaw: bigint;
  sizeRaw: bigint;
}

export interface KuruBook {
  market: Address;
  block: bigint;
  scale: MarketScale;
  fees: { takerPps: bigint; makerPps: bigint };
  baseToken: Address;
  quoteToken: Address;
  state: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

const EMPTY_BID = 0xffff_ffffn;

// Reads the book and the market's own unit facts straight from the OrderBook contract, so nothing about
// decimals or tokens is assumed. The hosted gateway is not used because its compatibility with this
// deployment is unconfirmed in Kuru's own docs.
export async function readKuruBook(pc: PublicClient, market: Address, levels = 12): Promise<KuruBook> {
  const { abi } = await loadSdk();
  const orderBookAbi = abi.orderBookAbi;
  const blockNumber = await pc.getBlockNumber({ cacheTime: 0 });
  const read = <F extends string>(functionName: F, args?: readonly unknown[]) =>
    pc.readContract({ address: market, abi: orderBookAbi, functionName, args, blockNumber } as never) as Promise<never>;
  const [params, book, baseToken, quoteToken, quoteDecimals, baseSizeMultiplier, state] = await Promise.all([
    read("getMarketParams") as Promise<readonly [number, bigint, number, bigint, bigint, bigint, bigint]>,
    read("getL2Book", [BigInt(levels)]) as Promise<readonly [readonly number[], readonly bigint[], readonly number[], readonly bigint[]]>,
    read("baseToken") as Promise<Address>,
    read("quoteToken") as Promise<Address>,
    read("quoteTokenDecimals") as Promise<number>,
    read("baseSizeMultiplier") as Promise<bigint>,
    read("marketState") as Promise<number>,
  ]);
  const [pricePrecision, sizePrecision, tickSize, minQuote, maxQuote, takerPps, makerPps] = params;
  precisionDecimals(BigInt(pricePrecision));
  const sizeDecimals = precisionDecimals(BigInt(sizePrecision));
  // baseSizeMultiplier = 10^baseDecimals / sizePrecision
  const baseDecimals = precisionDecimals(BigInt(baseSizeMultiplier)) + sizeDecimals;
  const [bidPrices, bidSizes, askPrices, askSizes] = book;
  const side = (prices: readonly (number | bigint)[], sizes: readonly (number | bigint)[], isBid: boolean): BookLevel[] =>
    prices
      .map((p, i) => ({ priceRaw: BigInt(p), sizeRaw: BigInt(sizes[i] ?? 0) }))
      .filter((l) => l.sizeRaw > 0n && l.priceRaw > 0n && (!isBid || l.priceRaw !== EMPTY_BID));
  return {
    market,
    block: blockNumber,
    scale: {
      pricePrecision: BigInt(pricePrecision),
      sizePrecision: BigInt(sizePrecision),
      tickSize: BigInt(tickSize),
      minQuote: BigInt(minQuote),
      maxQuote: BigInt(maxQuote),
      baseDecimals,
      quoteDecimals: Number(quoteDecimals),
    },
    fees: { takerPps: BigInt(takerPps), makerPps: BigInt(makerPps) },
    baseToken,
    quoteToken,
    state: Number(state),
    bids: side(bidPrices, bidSizes, true),
    asks: side(askPrices, askSizes, false),
  };
}

// Facts the contract states about itself, compared with what this app expects. Any entry means the market is
// not the one the page claims to trade.
export function marketIssues(book: KuruBook, expected: { base: Address; quote: Address }): string[] {
  const issues: string[] = [];
  if (book.baseToken.toLowerCase() !== expected.base.toLowerCase()) issues.push(`Its base token is ${book.baseToken}, not the Piry claim ${expected.base}.`);
  if (book.quoteToken.toLowerCase() !== expected.quote.toLowerCase()) issues.push(`Its quote token is ${book.quoteToken}, not ${expected.quote}.`);
  if (book.state !== 0) issues.push(`Its market state is ${book.state}, not active (0).`);
  return issues;
}

export async function estimateSwap(
  pc: PublicClient,
  market: Address,
  isBuy: boolean,
  amountIn: bigint,
  userId: bigint | null,
): Promise<{ amountInUsed: bigint; amountOut: bigint }> {
  const { abi } = await loadSdk();
  const result =
    userId === null || userId === 0n
      ? await pc.readContract({ address: market, abi: abi.orderBookAbi, functionName: "estimateSwap", args: [isBuy, amountIn] })
      : await pc.readContract({ address: market, abi: abi.orderBookAbi, functionName: "estimateSwap", args: [Number(userId), isBuy, amountIn] });
  return { amountInUsed: result.amountInUsed, amountOut: result.amountOut };
}

export interface KuruBalance {
  token: Address;
  free: bigint;
  reserved: bigint;
}

export interface KuruAccountView {
  block: bigint;
  rootId: bigint;
  balances: KuruBalance[];
}

export async function readKuruAccount(pc: PublicClient, accountCore: Address, owner: Address, tokens: Address[]): Promise<KuruAccountView> {
  const { createAccountClient } = await loadSdk();
  const account = createAccountClient({ publicClient: pc, addresses: { accountCore } });
  const block = await pc.getBlockNumber({ cacheTime: 0 });
  const rootId = await account.getRootAccountId({ rootOwner: owner });
  if (rootId === 0n) {
    return { block, rootId, balances: tokens.map((token) => ({ token, free: 0n, reserved: 0n })) };
  }
  const balances = await Promise.all(
    tokens.map(async (token) => {
      const [free, reserved] = await Promise.all([
        account.getBalance({ accountId: rootId, token }),
        account.getSpotReservedBalance({ accountId: rootId, token }),
      ]);
      return { token, free, reserved };
    }),
  );
  return { block, rootId, balances };
}

export interface OpenOrder {
  slot: number;
  orderId: bigint;
}

const SLOTS = 62;

export async function readOpenOrders(pc: PublicClient, market: Address, rootId: bigint, accountCore: Address): Promise<OpenOrder[]> {
  if (rootId === 0n) return [];
  const { createSpotClient } = await loadSdk();
  const spot = createSpotClient({ publicClient: pc, addresses: { accountCore } });
  const ids = await Promise.all(Array.from({ length: SLOTS }, (_, slot) => spot.getOrderId({ market, userId: rootId, slotIdx: slot })));
  return ids.flatMap((orderId, slot) => (orderId === 0n ? [] : [{ slot, orderId }]));
}

export interface Session {
  pc: PublicClient;
  owner: Address;
  accountCore: Address;
  account: Awaited<ReturnType<typeof makeClients>>["account"];
  spot: Awaited<ReturnType<typeof makeClients>>["spot"];
}

async function makeClients(pc: PublicClient, wallet: WalletClient, accountCore: Address) {
  const { createAccountClient, createSpotClient } = await loadSdk();
  const owner = wallet.account;
  if (!owner) throw new Error("Connect a wallet first");
  const shared = { publicClient: pc, walletClient: wallet, account: owner, addresses: { accountCore } } as const;
  return { account: createAccountClient(shared), spot: createSpotClient(shared) };
}

export async function openSession(pc: PublicClient, wallet: WalletClient, accountCore: Address): Promise<Session> {
  const owner = wallet.account?.address;
  if (!owner) throw new Error("Connect a wallet first");
  const clients = await makeClients(pc, wallet, accountCore);
  return { pc, owner, accountCore, ...clients };
}

export async function confirmed(pc: PublicClient, hash: Hash): Promise<TransactionReceipt> {
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}

// Approve (when needed) and deposit into the Kuru trading balance. Returns the deposit hash.
export async function depositToKuru(s: Session, token: Address, amount: bigint): Promise<Hash> {
  const allowance = await s.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [s.owner, s.accountCore] });
  if (allowance < amount) {
    await confirmed(s.pc, await s.account.approveErc20({ token, spender: s.accountCore, amount }));
  }
  return s.account.depositToOwner({ rootOwner: s.owner, token, amount });
}

export async function withdrawFromKuru(s: Session, token: Address, amount: bigint): Promise<Hash> {
  const rootId = await s.account.getRootAccountId({ rootOwner: s.owner });
  if (rootId === 0n) throw new Error("No Kuru account for this wallet");
  return s.account.withdraw({ rootAccountId: rootId, token, amount, recipient: s.owner });
}

export interface LimitOrder {
  market: Address;
  rootId: bigint;
  isBuy: boolean;
  priceRaw: bigint;
  sizeRaw: bigint;
  postOnly: boolean;
}

export function placeLimit(s: Session, o: LimitOrder): Promise<Hash> {
  return s.spot.batch({
    market: o.market,
    userId: o.rootId,
    orders: [
      {
        side: o.isBuy ? "buy" : "sell",
        quantity: o.sizeRaw,
        price: o.priceRaw,
        tif: "gtc",
        executionInstruction: o.postOnly ? "postOnly" : "none",
        minSizeAfterBlock: 0n,
      },
    ],
    cancelSlotIdxs: [],
  });
}

export interface MarketSwap {
  market: Address;
  rootId: bigint;
  isBuy: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
}

export function placeSwap(s: Session, o: MarketSwap): Promise<Hash> {
  return s.spot.swap({
    market: o.market,
    userId: o.rootId,
    isBuy: o.isBuy,
    amountIn: o.amountIn,
    minAmountOut: o.minAmountOut,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
  });
}

export function cancelSlots(s: Session, market: Address, rootId: bigint, slots: number[]): Promise<Hash> {
  return s.spot.cancelBySlots({ market, userId: rootId, cancelSlotIdxs: slots });
}

export interface OrderOutcome {
  label: string;
  fills: number;
  filledSize: bigint;
  restingSize: bigint | null;
}

// A successful transaction is not a resting order: read what the market actually did with it.
export async function describeOutcome(receipt: TransactionReceipt, market: Address): Promise<OrderOutcome> {
  const { events } = await loadSdk();
  const names = events.OperationOutcome as unknown as Record<number, string>;
  const outcomes = new Set<string>();
  let fills = 0;
  let filledSize = 0n;
  let restingSize: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue;
    const decoded = events.decodeKuruEventLog(log as { data: Hex; topics: readonly [Hex, ...Hex[]] }) as unknown as {
      eventName?: string;
      args?: { packedTrades?: Hex; packedUpdates?: Hex };
    };
    if (decoded.eventName === "TradesPacked" && decoded.args?.packedTrades) {
      for (const trade of events.decodeTradesPacked(decoded.args.packedTrades)) {
        if (trade.fillSize > 0n) {
          fills += 1;
          filledSize += trade.fillSize;
        }
        if (names[trade.outcome] && trade.outcome !== 0) outcomes.add(names[trade.outcome] as string);
      }
    }
    if (decoded.eventName === "BookUpdatesPacked" && decoded.args?.packedUpdates) {
      for (const update of events.decodeBookUpdatesPacked(decoded.args.packedUpdates)) {
        if (names[update.outcome] && update.outcome !== 0) outcomes.add(names[update.outcome] as string);
        if (update.isLive && !update.isSentinel) restingSize = (restingSize ?? 0n) + update.size;
      }
    }
  }
  // Swaps log untagged fills, so a fill with no outcome tag still counts as FILLED.
  const label = outcomes.size > 0 ? [...outcomes].join(", ") : fills > 0 ? "FILLED" : "NOT_FILLED";
  return { label, fills, filledSize, restingSize };
}
