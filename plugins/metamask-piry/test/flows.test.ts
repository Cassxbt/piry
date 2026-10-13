import assert from "node:assert/strict";
import { test } from "node:test";
import { SERIES } from "../src/config.js";
import { describeFailure } from "../src/failure.js";
import { hedge, sizeBuy, type HedgeInput } from "../src/hedge.js";
import { position } from "../src/position.js";
import { quote } from "../src/quote.js";
import { redeem } from "../src/redeem.js";
import { unwind } from "../src/unwind.js";
import { Budget, Run } from "../src/tx.js";
import { adaptExecutor } from "../src/wallet.js";
import { OWNER, SHORT_MARKET, LONG_MARKET, Sim } from "./sim.js";

const U = 1_000_000n;
const input = (over: Partial<HedgeInput> = {}): HedgeInput => ({ gpuHoursMicro: 100n * U, maxPremium: 100n * U, slippageBps: 100, allowMint: false, shortTo: null, ...over });
const deps = (sim: Sim, over: { long?: boolean; short?: boolean } = {}) => ({ client: sim.reader, config: sim.config(over), wallet: sim.wallet });
const fns = (sim: Sim) => sim.sent.map((s) => s.fn);
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code?: string; message: string }; } assert.fail("expected rejection"); };

test("quote sizes the hedge from the on-chain mark and degrades without a Kuru market", async () => {
  const sim = new Sim();
  const q = await quote(sim.reader, sim.config(), 500n * U);
  assert.equal(q.index.usdPerGpuHour, "3.4085");
  assert.equal(q.hedge?.claims, "1000");
  assert.equal(q.hedge?.fairPremiumAtMarkUsdc, "454.25");
  assert.equal(q.kuru.status, "NOT_LISTED");
  assert.deepEqual(q.hedge?.scenarios.at(-1), { indexUsd: "5.5", billAboveFloorUsd: "1500", hedgePayoutUsdc: "1000", uncoveredUsd: "500" });
  assert.equal(sim.sent.length, 0);
});

test("quote reads the Kuru book when a market is configured", async () => {
  const sim = new Sim();
  const q = await quote(sim.reader, sim.config({ long: true }), 100n * U);
  assert.equal(q.kuru.status, "LIVE");
  assert.equal(q.kuru.bestAskUsdc, "0.45");
  assert.equal(q.kuru.costToBuyHedgeUsdc, "90");
});

test("hedge buys on Kuru: approve, deposit, swap with a slippage floor, withdraw", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { long: true }), input());
  assert.equal(r.status, "HEDGED");
  assert.equal(r.path, "kuru");
  assert.deepEqual(fns(sim), ["approve", "deposit", "swap", "withdraw"]);
  const swap = sim.sent[2]!;
  assert.deepEqual(swap.args.slice(1, 4), [true, 90n * U, 198n * U]); // buy, spend 90, floor 99% of 200
  assert.equal(sim.bal.long, 200n * U);
  assert.equal(sim.bal.usdc, 1_000n * U - 90n * U);
  assert.equal(r.after?.spentUsdc, "90");
  assert.ok(sim.sent.every((s) => s.intent.summary.startsWith("Piry:") && s.intent.action === "custom"));
});

test("hedge never spends past --max-premium and reports a partial fill", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { long: true }), input({ maxPremium: 50n * U }));
  assert.equal(r.status, "PARTIAL");
  assert.ok(sim.bal.usdc! >= 1_000n * U - 50n * U);
  assert.equal(sim.kuruBal.usdc, 0n);
  assert.match(r.warnings.join(" "), /partial/);
});

test("hedge without --max-premium previews and sends nothing", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { long: true }), input({ maxPremium: null }));
  assert.equal(r.status, "PREVIEW");
  assert.equal(r.plan.spendUsdc, "90");
  assert.equal(sim.sent.length, 0);
});

test("hedge counts claims already held and skips a covered hedge", async () => {
  const sim = new Sim();
  sim.bal.long = 250n * U;
  const r = await hedge(deps(sim, { long: true }), input());
  assert.equal(r.status, "ALREADY_HEDGED");
  assert.equal(sim.sent.length, 0);
  const tail = new Sim();
  tail.bal.long = 150n * U;
  const t = await hedge(deps(tail, { long: true }), input());
  assert.equal(t.claimsToAcquire, "50");
});

test("PIRY-S held offsets the net long position", async () => {
  const sim = new Sim();
  sim.bal.long = 200n * U;
  sim.bal.short = 200n * U;
  const r = await hedge(deps(sim, { long: true }), input({ maxPremium: null }));
  assert.equal(r.alreadyHeldNetLong, "0");
  assert.match(r.warnings.join(" "), /PIRY-S/);
});

test("hedge is refused after the period ends and after settlement", async () => {
  const late = new Sim();
  late.now = late.periodEnd + 1n;
  assert.equal((await rejects(hedge(deps(late, { long: true }), input()))).code, "SERIES_CLOSED");
  const done = new Sim();
  done.settled = true;
  assert.equal((await rejects(hedge(deps(done, { long: true }), input()))).code, "SERIES_CLOSED");
});

test("insufficient USDC fails before anything is sent", async () => {
  const sim = new Sim();
  sim.bal.usdc = 10n * U;
  assert.equal((await rejects(hedge(deps(sim, { long: true }), input()))).code, "INSUFFICIENT_BALANCE");
  assert.equal(sim.sent.length, 0);
});

test("without a Kuru market hedge reports UNAVAILABLE and mints only with --allow-mint", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim), input());
  assert.equal(r.status, "UNAVAILABLE");
  assert.equal(sim.sent.length, 0);
  assert.match(r.next, /--allow-mint/);
});

test("mint fallback with no short market leaves both legs and says the hedge is not active", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim), input({ gpuHoursMicro: 50n * U, allowMint: true }));
  assert.equal(r.status, "UNHEDGED_PAIR");
  assert.equal(r.path, "mint");
  assert.deepEqual(fns(sim), ["approve", "mintPairs"]);
  assert.match(r.next, /NOT active/);
  assert.equal(sim.bal.long, 100n * U);
  assert.equal(sim.bal.short, 100n * U);
});

test("mint fallback sells the PIRY-S leg on the short market, activating the hedge", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true }));
  assert.equal(r.status, "HEDGED");
  assert.deepEqual(fns(sim), ["approve", "mintPairs", "approve", "deposit", "swap", "withdraw"]);
  assert.equal(sim.bal.long, 200n * U);
  assert.equal(sim.bal.short, 0n);
  assert.equal(r.after?.spentUsdc, "90"); // 200 locked, 110 back from selling PIRY-S at 0.55
  assert.deepEqual(sim.sent[4]!.args.slice(1, 4), [false, 200n * U, 108_900_000n]);
});

test("mint fallback is capped and can hand the short leg to a counterparty", async () => {
  const sim = new Sim();
  const cp = "0x5555555555555555555555555555555555555555" as const;
  const r = await hedge(deps(sim), input({ maxPremium: 120n * U, allowMint: true, shortTo: cp }));
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(fns(sim), ["approve", "mintPairs", "transfer"]);
  assert.equal(sim.bal.long, 120n * U);
  assert.equal(sim.bal.short, 0n);
  assert.equal(sim.sent[2]!.tx.to, SERIES.shortClaim);
});

test("a configured market with the wrong base token is refused before anything is sent", async () => {
  const sim = new Sim();
  sim.books.get(LONG_MARKET.toLowerCase())!.base = SERIES.collateral;
  assert.equal((await rejects(hedge(deps(sim, { long: true }), input()))).code, "KURU_MARKET_MISMATCH");
  assert.equal(sim.sent.length, 0);
});

test("a wrong chain or mismatched series contract stops everything", async () => {
  const sim = new Sim();
  sim.chainId = 1;
  assert.equal((await rejects(hedge(deps(sim), input()))).code, "WRONG_CHAIN");
  const q = new Sim();
  (q.reader as { readContract: unknown }).readContract = async (r: { address: string; functionName: string }) =>
    r.functionName === "longClaim" ? "0x9999999999999999999999999999999999999999" : (new Sim().reader.readContract as (x: unknown) => unknown)(r);
  assert.equal((await rejects(quote(q.reader, q.config(), null))).code, "SERIES_MISMATCH");
});

test("sizeBuy walks the budget up to the cap and stops when the book is exhausted", async () => {
  const flat = (amountIn: bigint) => Promise.resolve({ amountInUsed: amountIn, amountOut: amountIn * 2n });
  assert.deepEqual(await sizeBuy(flat, 200n, 50n, null), { amountIn: 101n, expectedOut: 202n, complete: true }); // one unit of headroom
  const capped = await sizeBuy(flat, 200n, 50n, 60n);
  assert.deepEqual(capped, { amountIn: 60n, expectedOut: 120n, complete: false });
  const dry = await sizeBuy((n) => Promise.resolve({ amountInUsed: 10n, amountOut: 20n }), 200n, 50n, null);
  assert.deepEqual(dry, { amountIn: 10n, expectedOut: 20n, complete: false });
  assert.equal((await sizeBuy(() => Promise.resolve({ amountInUsed: 0n, amountOut: 0n }), 5n, 4n, null)).expectedOut, 0n);
});

test("the Run budget blocks an over-cap step before it reaches the wallet", async () => {
  let called = 0;
  const run = new Run({ address: OWNER, send: async () => { called++; return { hash: "0x01", status: "CONFIRMED" }; } }, new Budget(100n));
  await run.send("a", "x", { to: OWNER, data: "0x" }, 60n);
  await assert.rejects(run.send("b", "x", { to: OWNER, data: "0x" }, 41n), { code: "CAP_EXCEEDED" });
  assert.equal(called, 1);
  assert.equal(run.budget.spent, 60n);
});

test("a wallet failure mid-run reports the steps that already landed", async () => {
  const sim = new Sim();
  sim.failOn = "swap";
  sim.failWith = "Policy denied the transaction";
  const e = await rejects(hedge(deps(sim, { long: true }), input()));
  const f = describeFailure(e);
  assert.equal(f.code, "TRANSACTION_FAILED");
  assert.match(f.message, /Step "swap" failed after approve/);
  assert.match(f.message, /Policy denied/);
  assert.match(f.hint, /position/);
  assert.deepEqual(fns(sim), ["approve", "deposit"]);
  assert.equal(sim.kuruBal.usdc, 90n * U); // funds sit in the Kuru trading balance, which position reports
});

test("the host's Invalid chainId failure is mapped to a fix", () => {
  const f = describeFailure(new Error("Gas fee/price estimation failed. Message: ... Invalid chainId"));
  assert.equal(f.code, "MM_CHAIN_RPC_UNAVAILABLE");
  assert.match(f.hint, /customEvmChains/);
});

test("position reports wallet and Kuru balances, mark value and the covered GPU-hours", async () => {
  const sim = new Sim();
  sim.bal.long = 100n * U;
  sim.bal.short = 20n * U;
  sim.kuruRoot = 7n;
  sim.kuruBal.long = 100n * U;
  const p = await position(sim.reader, sim.config(), OWNER);
  assert.equal(p.series.status, "OPEN");
  assert.equal(p.claims.netLong, "180");
  assert.equal(p.claims.coveredGpuHours, "90");
  assert.equal(p.valueUsdc.longAtMark, "90.85");
  assert.equal(p.valueUsdc.shortAtMark, "10.915"); // 20 x 0.54575 from the short feed
  assert.equal(p.series.latestIndexUsd, "3.4085");
});

test("position flags a stale mark", async () => {
  const sim = new Sim();
  sim.markAge = 5_000n;
  assert.match((await position(sim.reader, sim.config(), OWNER)).warnings.join(" "), /stale/);
});

test("redeem before settlement is refused with the fallback timing", async () => {
  const sim = new Sim();
  sim.bal.long = 10n * U;
  const e = await rejects(redeem(deps(sim), { minPayout: null }));
  assert.equal(e.code, "NOT_SETTLED");
  assert.equal(sim.sent.length, 0);
});

test("redeem withdraws from Kuru, guards the payout and lands the USDC", async () => {
  const sim = new Sim();
  sim.settled = true;
  sim.settlementPrice = 3_500_000n;
  sim.bal.long = 100n * U;
  sim.kuruRoot = 7n;
  sim.kuruBal.long = 100n * U;
  const before = sim.bal.usdc!;
  const r = await redeem(deps(sim, { long: true }), { minPayout: null });
  assert.deepEqual(fns(sim), ["withdraw", "redeem"]);
  assert.equal(r.expectedPayoutUsdc, "100"); // 200 long x (3.5 - 2.5) / 2
  assert.equal(sim.sent[1]!.args[3], 100n * U); // default min payout is the exact preview
  assert.equal(sim.bal.usdc, before + 100n * U);
  assert.equal(r.receivedUsdc, "100");
});

test("redeem refuses a payout below --min-payout and a contract preview that disagrees with the local math", async () => {
  const sim = new Sim();
  sim.settled = true;
  sim.settlementPrice = 3_500_000n;
  sim.bal.long = 100n * U;
  assert.equal((await rejects(redeem(deps(sim), { minPayout: 80n * U }))).code, "PAYOUT_BELOW_MIN");
  sim.previewOffset = 1n;
  assert.equal((await rejects(redeem(deps(sim), { minPayout: null }))).code, "PREVIEW_MISMATCH");
  assert.equal(sim.sent.length, 0);
});

test("unwind merges pairs first, then sells the rest on Kuru with a proceeds floor", async () => {
  const sim = new Sim();
  sim.bal.long = 150n * U;
  sim.bal.short = 50n * U;
  const r = await unwind(deps(sim, { long: true }), { claims: null, method: "auto", slippageBps: 100, minProceeds: null });
  assert.equal(r.mergedPairs, "50");
  assert.equal(r.soldClaims, "100");
  assert.deepEqual(fns(sim), ["mergePairs", "approve", "deposit", "swap", "withdraw"]);
  assert.deepEqual(sim.sent[3]!.args.slice(1, 4), [false, 100n * U, 44_550_000n]); // floor 99% of 45
  assert.equal(r.longClaimsLeft, "0");
});

test("unwind enforces --min-proceeds and refuses to sell with no market", async () => {
  const sim = new Sim();
  sim.bal.long = 100n * U;
  assert.equal((await rejects(unwind(deps(sim, { long: true }), { claims: null, method: "sell", slippageBps: 100, minProceeds: 90n * U }))).code, "PROCEEDS_BELOW_MIN");
  assert.equal((await rejects(unwind(deps(sim), { claims: null, method: "sell", slippageBps: 100, minProceeds: null }))).code, "KURU_UNAVAILABLE");
  const auto = await unwind(deps(sim), { claims: null, method: "auto", slippageBps: 100, minProceeds: null });
  assert.equal(auto.executed, false);
  assert.equal(sim.sent.length, 0);
  assert.equal((await rejects(unwind(deps(sim), { claims: 500n * U, method: "auto", slippageBps: 100, minProceeds: null }))).code, "INSUFFICIENT_CLAIMS");
});

test("short market is read and verified only when configured", async () => {
  const sim = new Sim();
  sim.books.get(SHORT_MARKET.toLowerCase())!.base = SERIES.longClaim;
  assert.equal((await rejects(hedge(deps(sim, { short: true }), input({ allowMint: true })))).code, "KURU_MARKET_MISMATCH");
});

test("the host adapter submits exactly one transaction request per step and waits for the receipt", async () => {
  const seen: { request: unknown; options: unknown }[] = [];
  const wallet = adaptExecutor(OWNER, async (request, options) => { seen.push({ request, options }); return { hash: "0xabc", status: "CONFIRMED" }; });
  const receipt = await wallet.send({ to: SERIES.market, data: "0x1234" }, { summary: "Piry: test", action: "custom" });
  assert.deepEqual(receipt, { hash: "0xabc", status: "CONFIRMED" });
  assert.deepEqual(seen, [{
    request: { kind: "transaction", chainId: 10143, transaction: { to: SERIES.market, data: "0x1234" }, intent: { summary: "Piry: test", action: "custom" } },
    options: { signal: undefined, waitForReceipt: true },
  }]);
});

test("a wallet answer without a transaction hash is a failed step, not a success", async () => {
  const wallet = adaptExecutor(OWNER, async () => ({ hash: "", status: "BROADCASTED" }));
  const run = new Run(wallet, new Budget(null));
  await assert.rejects(run.send("mint", "x", { to: SERIES.market, data: "0x" }), { name: "StepFailed" });
});

test("a market AccountCore does not verify is refused even when its tokens match", async () => {
  const sim = new Sim();
  sim.unverified.add(LONG_MARKET.toLowerCase());
  const e = await rejects(hedge(deps(sim, { long: true }), input()));
  assert.equal(e.code, "KURU_MARKET_MISMATCH");
  assert.match(e.message, /verified spot order book/);
  assert.equal(sim.sent.length, 0);
  const q = await quote(sim.reader, sim.config({ long: true }), 100n * U);
  assert.equal(q.kuru.status, "MISMATCH");
});

test("a stale Kuru price stops hedge, unwind and redeem before anything is proposed", async () => {
  const sim = new Sim();
  sim.priceStale = true;
  assert.equal((await rejects(hedge(deps(sim, { long: true }), input()))).code, "PRICE_STALE");
  assert.equal((await rejects(hedge(deps(sim, { long: true }), input({ maxPremium: null })))).code, "PRICE_STALE");
  sim.bal.long = 50n * U;
  assert.equal((await rejects(unwind(deps(sim, { long: true }), { claims: null, method: "sell", slippageBps: 100, minProceeds: null }))).code, "PRICE_STALE");
  sim.settled = true;
  sim.settlementPrice = 3_500_000n;
  sim.kuruRoot = 7n;
  sim.kuruBal.long = 10n * U;
  assert.equal((await rejects(redeem(deps(sim), { minPayout: null }))).code, "PRICE_STALE");
  assert.equal(sim.sent.length, 0);
});

test("a fresh price lets hedge through and the limiter was asked about the claim", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { long: true }), input());
  assert.equal(r.status, "HEDGED");
  assert.ok(sim.limiterChecked.includes(SERIES.longClaim.toLowerCase()));
});

test("the limiter's revert selector maps to PRICE_STALE even when it surfaces from the host", () => {
  assert.equal(describeFailure(new Error("execution reverted: 0x393843a9")).code, "PRICE_STALE");
});

test("an unreadable limiter fails closed", async () => {
  const sim = new Sim();
  const read = sim.reader.readContract;
  sim.reader = { ...sim.reader, readContract: ((req: { functionName: string }) => (req.functionName === "requireFreshPrice" ? Promise.reject(new Error("rpc down")) : (read as (r: unknown) => unknown)(req))) as never };
  assert.equal((await rejects(hedge({ client: sim.reader, config: sim.config({ long: true }), wallet: sim.wallet }, input()))).code, "PRICE_CHECK_FAILED");
  assert.equal(sim.sent.length, 0);
});

test("an order below the market minimum notional is refused, not warned about", async () => {
  const sim = new Sim();
  const e = await rejects(hedge(deps(sim, { long: true }), input({ gpuHoursMicro: 1n * U })));
  assert.equal(e.code, "BELOW_MIN_NOTIONAL");
  assert.equal(sim.sent.length, 0);
});

test("hedge refuses once the series is settled and points to redeem", async () => {
  const sim = new Sim();
  sim.settled = true;
  sim.settlementPrice = 3_500_000n;
  const e = await rejects(hedge(deps(sim, { long: true }), input({ allowMint: true })));
  assert.equal(e.code, "SERIES_CLOSED");
  assert.match(e.message, /Series settled; use redeem/);
  assert.equal(sim.sent.length, 0);
});

test("the mark is flagged stale after 1500 seconds, not before", async () => {
  const sim = new Sim();
  sim.markAge = 1_400n;
  assert.doesNotMatch((await position(sim.reader, sim.config(), OWNER)).warnings.join(" "), /stale/);
  sim.markAge = 1_501n;
  assert.match((await position(sim.reader, sim.config(), OWNER)).warnings.join(" "), /stale/);
});
