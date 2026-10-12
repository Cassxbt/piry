// Exercises the app's Kuru code path (src/lib/kuru.ts) against the real Kuru V2 contracts, on a LOCAL Anvil
// fork of Monad testnet. Nothing is sent to a public network: the script refuses any non-loopback RPC.
//
//   anvil --fork-url https://testnet-rpc.monad.xyz --port 8546 --chain-id 10143 --compute-units-per-second 8 --retries 20 --fork-retry-backoff 500
//   npx tsx scripts/kuru-fork-smoke.ts
//
// Flow: read book -> fund a throwaway account -> deposit quote token -> post-only limit buy -> decode the
// outcome -> find the open order -> cancel -> market buy with a slippage floor -> withdraw.
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, getAddress, http, keccak256, pad, toHex, parseUnits, type Address } from "viem";
import { monadTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cancelSlots, depositToKuru, describeOutcome, estimateSwap, openSession, placeLimit, placeSwap, readKuruAccount, readKuruBook, readOpenOrders, withdrawFromKuru, confirmed } from "../src/lib/kuru.ts";
import { checkLimitOrder, quoteNotional, slippageFloor, toSizeRaw } from "../src/lib/kuruMath.ts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const host = new URL(RPC).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error(`Refusing non-loopback RPC ${RPC}: this script sends transactions.`);

const config = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "config", "monad-testnet.json"), "utf8")) as {
  kuru: { accountCore: Address; quoteToken: Address; quoteDecimals: number };
};
const MARKET: Address = getAddress(process.env.KURU_MARKET ?? "0x26cd68436B6A4AEB3ec52abC20A4d121f8B4BAc9");
const { accountCore, quoteToken, quoteDecimals } = config.kuru;

const transport = http(RPC, { retryCount: 6, retryDelay: 400 });
const pc = createPublicClient({ chain: monadTestnet, transport });
if ((await pc.getChainId()) !== 10143) throw new Error("Expected a fork with chain id 10143");

const rpc = (method: string, params: unknown[]) => (pc as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method, params });
const trader = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
await rpc("anvil_setBalance", [trader, toHex(parseUnits("100", 18))]);
const wallet = createWalletClient({ account: trader, chain: monadTestnet, transport });

const log: Record<string, unknown> = { market: MARKET, trader };
const step = (name: string, value: unknown) => { log[name] = value; console.log(name, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); };

// Fund the trader with the quote token by writing its balance slot (the token is an admin-mintable test token).
const fund = parseUnits("1000", quoteDecimals);
let funded = false;
for (let slot = 0; slot < 16 && !funded; slot++) {
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [trader, BigInt(slot)]));
  await rpc("anvil_setStorageAt", [quoteToken, key, pad(toHex(fund), { size: 32 })]);
  funded = (await pc.readContract({ address: quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [trader] })) === fund;
}
if (!funded) throw new Error("Could not find the quote token balance slot");
step("funded", { token: quoteToken, amount: fund.toString() });

const book = await readKuruBook(pc, MARKET, 8);
step("book", { block: book.block, baseToken: book.baseToken, quoteToken: book.quoteToken, state: book.state, scale: book.scale, fees: book.fees, bestBid: book.bids[0] ?? null, bestAsk: book.asks[0] ?? null, levels: [book.bids.length, book.asks.length] });

const session = await openSession(pc, wallet, accountCore);
const baseline = await readKuruAccount(pc, accountCore, trader, [quoteToken]);
const baselineFree = baseline.balances[0]?.free ?? 0n;
const baselineOrders = baseline.rootId === 0n ? 0 : (await readOpenOrders(pc, MARKET, baseline.rootId, accountCore)).length;
const depositAmount = parseUnits("500", quoteDecimals);
const depositHash = await depositToKuru(session, quoteToken, depositAmount);
await confirmed(pc, depositHash);
let account = await readKuruAccount(pc, accountCore, trader, [quoteToken]);
step("afterDeposit", { rootId: account.rootId, free: account.balances[0]?.free });
if (account.rootId === 0n || (account.balances[0]?.free ?? 0n) - baselineFree !== depositAmount) throw new Error("Deposit did not credit the Kuru balance");

// Post-only buy well below the best bid so it rests. Price is half the best bid (or a floor), tick-aligned.
const reference = book.bids[0]?.priceRaw ?? book.asks[0]?.priceRaw ?? 25_000n;
let priceRaw = reference / 2n;
priceRaw -= priceRaw % book.scale.tickSize;
if (priceRaw <= 0n) priceRaw = book.scale.tickSize;
const wantedQuote = 12n * 10n ** BigInt(quoteDecimals);
let sizeRaw = (wantedQuote * book.scale.sizePrecision * book.scale.pricePrecision) / (priceRaw * 10n ** BigInt(quoteDecimals)) + 1n;
const problem = checkLimitOrder(priceRaw, sizeRaw, book.scale);
if (problem) throw new Error(`Own validator rejects the order: ${problem}`);
step("limitOrder", { priceRaw, sizeRaw, notional: quoteNotional(priceRaw, sizeRaw, book.scale), parsedSize: toSizeRaw("1", book.scale) });

const limitReceipt = await confirmed(pc, await placeLimit(session, { market: MARKET, rootId: account.rootId, isBuy: true, priceRaw, sizeRaw, postOnly: true }));
const outcome = await describeOutcome(limitReceipt, MARKET);
step("limitOutcome", outcome);

const orders = await readOpenOrders(pc, MARKET, account.rootId, accountCore);
step("openOrders", orders);
if (orders.length !== baselineOrders + 1) throw new Error(`Expected one new resting order, found ${orders.length - baselineOrders}`);

account = await readKuruAccount(pc, accountCore, trader, [quoteToken]);
step("reservedWhileResting", { free: account.balances[0]?.free, reserved: account.balances[0]?.reserved });

await confirmed(pc, await cancelSlots(session, MARKET, account.rootId, orders.map((o) => o.slot)));
const after = await readOpenOrders(pc, MARKET, account.rootId, accountCore);
account = await readKuruAccount(pc, accountCore, trader, [quoteToken]);
step("afterCancel", { openOrders: after.length, free: account.balances[0]?.free, reserved: account.balances[0]?.reserved });
if (after.length !== baselineOrders) throw new Error("Cancel did not remove the order");

// Market buy through the exact-input swap path, with the same slippage floor the ticket uses.
const spend = parseUnits("20", quoteDecimals);
const freeBeforeSwap = account.balances[0]?.free ?? 0n;
let estimate = { amountInUsed: 0n, amountOut: 0n };
if (book.asks.length > 0) {
  estimate = await estimateSwap(pc, MARKET, true, spend, account.rootId);
  const minOut = slippageFloor(estimate.amountOut, 50);
  step("swapEstimate", { ...estimate, minOut });
  const swapReceipt = await confirmed(pc, await placeSwap(session, { market: MARKET, rootId: account.rootId, isBuy: true, amountIn: spend, minAmountOut: minOut }));
  step("swapOutcome", await describeOutcome(swapReceipt, MARKET));
  account = await readKuruAccount(pc, accountCore, trader, [quoteToken]);
  step("afterSwap", { quoteSpent: freeBeforeSwap - (account.balances[0]?.free ?? 0n) });
  if (freeBeforeSwap - (account.balances[0]?.free ?? 0n) !== estimate.amountInUsed) throw new Error("Swap spent something other than the estimate");
} else {
  step("swapSkipped", "no asks on this market");
}

// Withdraw what is left of the quote token back to the wallet.
const withdrawAmount = account.balances[0]?.free ?? 0n;
try {
  await confirmed(pc, await withdrawFromKuru(session, quoteToken, withdrawAmount));
  step("withdrawn", { amount: withdrawAmount, wallet: await pc.readContract({ address: quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [trader] }) });
} catch (error) {
  step("withdrawBlocked", (error as Error).message.split("\n")[0]);
}

console.log("\nKuru fork smoke test finished. Fork only; no public transaction was sent.");

