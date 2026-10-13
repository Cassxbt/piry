import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { describeFailure } from "../src/failure.js";
import { hedge, type HedgeInput } from "../src/hedge.js";
import { Budget, Run, StepFailed, type Wallet } from "../src/tx.js";
import { OWNER, Sim } from "./sim.js";

const U = 1_000_000n;
const TX = { to: OWNER, data: "0x" as Hex };
const input = (over: Partial<HedgeInput> = {}): HedgeInput => ({ gpuHoursMicro: 100n * U, maxPremium: 100n * U, slippageBps: 100, allowMint: false, shortTo: null, ...over });
const deps = (sim: Sim, over: { long?: boolean; short?: boolean } = {}) => ({ client: sim.reader, config: sim.config(over), wallet: sim.wallet });
const fns = (sim: Sim) => sim.sent.map((s) => s.fn);
const failure = async (p: Promise<unknown>): Promise<StepFailed> => { try { await p; } catch (e) { assert.ok(e instanceof StepFailed, String(e)); return e; } assert.fail("expected StepFailed"); };
const answering = (hash: string, status: string | undefined): Wallet => ({ address: OWNER, send: async () => ({ hash: hash as Hex, status: status as string }) });
const chain = (result: "success" | "reverted" | "timeout") => ({
  waitForTransactionReceipt: async () => {
    if (result === "timeout") throw new Error("timed out");
    return { status: result };
  },
});

test("a hash with a FAILED status is not a completed step", async () => {
  const run = new Run(answering("0x01", "FAILED"), new Budget(5n), undefined, chain("success"));
  const e = await failure(run.send("swap", "x", TX, 5n));
  assert.equal(e.outcome, "FAILED");
  assert.equal(e.hash, "0x01");
  assert.equal(run.steps.length, 0);
});

test("every terminal host failure status is a failure even when the chain would say success", async () => {
  for (const status of ["FAILED", "BROADCAST_FAILED", "DENIED", "EXPIRED", "failed"]) {
    const run = new Run(answering("0x02", status), new Budget(null), undefined, chain("success"));
    assert.equal((await failure(run.send("a", "x", TX))).outcome, "FAILED", status);
  }
});

test("a broadcast-only answer is checked on chain: reverted is FAILED, success completes, no receipt is UNCERTAIN", async () => {
  const reverted = new Run(answering("0x03", "BROADCASTED"), new Budget(null), undefined, chain("reverted"));
  const failed = await failure(reverted.send("deposit", "x", TX));
  assert.equal(failed.outcome, "FAILED");
  assert.match(failed.message, /reverted/);
  assert.equal(reverted.steps.length, 0);

  const mined = new Run(answering("0x04", "BROADCASTED"), new Budget(null), undefined, chain("success"));
  const log = await mined.send("deposit", "x", TX);
  assert.equal(log.confirmedBy, "chain");
  assert.equal(log.status, "BROADCASTED");
  assert.equal(mined.steps.length, 1);

  const silent = new Run(answering("0x05", "BROADCASTED"), new Budget(null), undefined, chain("timeout"));
  const uncertain = await failure(silent.send("deposit", "x", TX));
  assert.equal(uncertain.outcome, "UNCERTAIN");
  assert.equal(uncertain.hash, "0x05");
  assert.equal(silent.steps.length, 0);
});

test("a missing or unknown status is verified on chain, and without a chain reader it is UNCERTAIN", async () => {
  for (const status of [undefined, "", "SOMETHING_NEW"]) {
    assert.equal((await new Run(answering("0x06", status), new Budget(null), undefined, chain("success")).send("a", "x", TX)).confirmedBy, "chain", String(status));
    assert.equal((await failure(new Run(answering("0x06", status), new Budget(null), undefined, chain("reverted")).send("a", "x", TX))).outcome, "FAILED", String(status));
    assert.equal((await failure(new Run(answering("0x06", status), new Budget(null)).send("a", "x", TX))).outcome, "UNCERTAIN", String(status));
  }
});

test("CONFIRMED completes on the host's word without a chain lookup", async () => {
  let lookups = 0;
  const counting = { waitForTransactionReceipt: async () => { lookups++; return { status: "success" as const }; } };
  const log = await new Run(answering("0x07", "CONFIRMED"), new Budget(null), undefined, counting).send("a", "x", TX);
  assert.equal(log.confirmedBy, "host");
  assert.equal(lookups, 0);
});

test("a wallet answer with no hash is UNCERTAIN, not a success", async () => {
  const e = await failure(new Run(answering("", "BROADCASTED"), new Budget(null), undefined, chain("success")).send("mint", "x", TX));
  assert.equal(e.outcome, "UNCERTAIN");
  assert.equal(e.hash, null);
});

test("a revert on step 2 stops the hedge before the swap and names every submitted hash", async () => {
  const sim = new Sim();
  sim.scripted.set(2, { status: "BROADCASTED", chain: "reverted" });
  const e = await failure(hedge(deps(sim, { long: true }), input()));
  assert.deepEqual(fns(sim), ["approve", "deposit"]);
  assert.equal(e.outcome, "FAILED");
  const f = describeFailure(e);
  assert.equal(f.code, "TRANSACTION_FAILED");
  assert.match(f.message, /FAILED/);
  for (const hash of [sim.sent[0]!.hash, sim.sent[1]!.hash]) assert.ok(f.message.includes(hash), `${hash} missing from: ${f.message}`);
  assert.match(f.hint, /do not retry/i);
  assert.doesNotMatch(f.hint, /retry only if nothing was sent/);
  assert.equal(sim.kuruBal.usdc, 0n);
});

test("a host FAILED status on the swap stops the withdraw and still prints the swap hash", async () => {
  const sim = new Sim();
  sim.scripted.set(3, { status: "FAILED", chain: "reverted" });
  const e = await failure(hedge(deps(sim, { long: true }), input()));
  assert.deepEqual(fns(sim), ["approve", "deposit", "swap"]);
  const f = describeFailure(e);
  assert.ok(f.message.includes(sim.sent[2]!.hash));
  assert.match(f.hint, /position/);
});

test("an unconfirmed swap is UNCERTAIN: nothing dependent is sent, hashes are printed, no retry is suggested", async () => {
  const sim = new Sim();
  sim.scripted.set(3, { status: "BROADCASTED", chain: "timeout" });
  const e = await failure(hedge(deps(sim, { long: true }), input()));
  assert.deepEqual(fns(sim), ["approve", "deposit", "swap"]);
  assert.equal(e.outcome, "UNCERTAIN");
  const f = describeFailure(e);
  assert.equal(f.code, "TRANSACTION_UNCERTAIN");
  assert.match(f.message, /UNCERTAIN/);
  for (const s of sim.sent) assert.ok(f.message.includes(s.hash));
  assert.match(f.hint, /may still land/);
  assert.match(f.hint, /do not retry/i);
});

test("a reverted mint stops the mint fallback before any sale step", async () => {
  const sim = new Sim();
  sim.scripted.set(2, { status: "BROADCASTED", chain: "reverted" });
  const e = await failure(hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true })));
  assert.deepEqual(fns(sim), ["approve", "mintPairs"]);
  assert.equal(e.outcome, "FAILED");
  assert.equal(sim.bal.short, 0n);
});

test("a failed USDC withdrawal after a successful PIRY-S sale reports the sale hash and the stranded USDC location", async () => {
  const sim = new Sim();
  sim.scripted.set(6, { status: "FAILED", chain: "reverted" });
  const e = await failure(hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true })));
  assert.deepEqual(fns(sim), ["approve", "mintPairs", "approve", "deposit", "swap", "withdraw"]);
  const f = describeFailure(e);
  for (const s of sim.sent) assert.ok(f.message.includes(s.hash));
  assert.equal(sim.kuruBal.usdc, 110n * U);
});
