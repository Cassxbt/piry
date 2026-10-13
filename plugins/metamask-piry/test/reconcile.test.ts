import assert from "node:assert/strict";
import { test } from "node:test";
import { hedge, type HedgeInput, type HedgeResult } from "../src/hedge.js";
import { position, type PositionResult } from "../src/position.js";
import { unwind } from "../src/unwind.js";
import { LONG_MARKET, OWNER, SHORT_MARKET, Sim } from "./sim.js";

const U = 1_000_000n;
const input = (over: Partial<HedgeInput> = {}): HedgeInput => ({ gpuHoursMicro: 100n * U, maxPremium: 100n * U, slippageBps: 100, allowMint: false, shortTo: null, ...over });
const deps = (sim: Sim, over: { long?: boolean; short?: boolean } = {}) => ({ client: sim.reader, config: sim.config(over), wallet: sim.wallet });
const fns = (sim: Sim) => sim.sent.map((s) => s.fn);
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code?: string; message: string }; } assert.fail("expected rejection"); };

// The book thins by the time the swap is submitted, as in the reviewer's harness.
const thinAtSwap = (sim: Sim, market: string, depth: bigint) => {
  sim.beforeWrite = (tx) => { if (tx.to.toLowerCase() === market.toLowerCase()) sim.books.get(market.toLowerCase())!.depth = depth; };
};

// Result and `position` must tell the same story: same net, and HEDGED only if the net reaches the target.
async function agrees(sim: Sim, over: { long?: boolean; short?: boolean }, r: HedgeResult): Promise<PositionResult> {
  const p = await position(sim.reader, sim.config(over), OWNER);
  assert.equal(r.after?.netLong, p.claims.netLong);
  assert.equal(r.after?.claimsLong, (Number(p.claims.longWallet) + Number(p.claims.longKuru)).toString());
  assert.equal(r.after?.claimsShort, (Number(p.claims.shortWallet) + Number(p.claims.shortKuru)).toString());
  assert.equal(r.status === "HEDGED", Number(p.claims.netLong) >= Number(r.targetClaims), `${r.status} with net ${p.claims.netLong} of ${r.targetClaims}`);
  return p;
}

test("a full Kuru buy reports requested, used and unspent quote and leaves nothing behind", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { long: true }), input());
  assert.equal(r.status, "HEDGED");
  assert.deepEqual(r.reconciliation?.quote, { requestedUsdc: "90", usedUsdc: "90", unspentUsdc: "0" });
  assert.deepEqual(r.reconciliation?.leftovers, []);
  assert.deepEqual(r.reconciliation?.recovery, []);
  assert.equal(r.after?.spentUsdc, "90");
  await agrees(sim, { long: true }, r);
});

test("a buy that fills less than planned is PARTIAL, reports the real spend and the USDC left in Kuru", async () => {
  const sim = new Sim();
  thinAtSwap(sim, LONG_MARKET, 199n * U);
  const r = await hedge(deps(sim, { long: true }), input());
  assert.equal(r.status, "PARTIAL");
  assert.equal(r.after?.spentUsdc, "89.55");
  assert.deepEqual(r.reconciliation?.quote, { requestedUsdc: "90", usedUsdc: "89.55", unspentUsdc: "0.45" });
  assert.deepEqual(r.reconciliation?.leftovers, [{ token: "USDC", where: "Kuru trading balance", amount: "0.45" }]);
  const p = await agrees(sim, { long: true }, r);
  assert.equal(p.usdc.kuruTrading, "0.45");
  assert.match(r.reconciliation!.recovery.join(" "), /0\.45 USDC/);
  assert.match(r.reconciliation!.recovery.join(" "), /withdraw\(rootAccountId 7, token 0xA402\w+, amount 450000 in raw units/);
});

test("PARTIAL never tells the user to re-run the same command; it points at position and a fresh preview", async () => {
  for (const [sim, over, extra] of [
    [(() => { const s = new Sim(); thinAtSwap(s, LONG_MARKET, 199n * U); return s; })(), { long: true }, {}],
    [new Sim(), { long: true }, { maxPremium: 50n * U }],
  ] as const) {
    const r = await hedge(deps(sim, over), input(extra));
    assert.equal(r.status, "PARTIAL");
    assert.doesNotMatch(r.next, /re-run the same command|top up/i);
    assert.match(r.next, /mm piry position/);
    assert.match(r.next, /mm piry hedge --gpu-hours 100/);
    assert.match(r.next, /without --max-premium|no --max-premium/);
    await agrees(sim, over, r);
  }
});

test("a partial mint-path hedge previews the remainder with the flags that selected the mint path", async () => {
  const sim = new Sim();
  thinAtSwap(sim, SHORT_MARKET, 199n * U);
  const cp = "0x5555555555555555555555555555555555555555" as const;
  const r = await hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true }));
  assert.match(r.next, /mm piry hedge --gpu-hours 100 --allow-mint\b/);
  const capped = await hedge(deps(new Sim()), input({ maxPremium: 120n * U, allowMint: true, shortTo: cp }));
  assert.equal(capped.status, "PARTIAL");
  assert.match(capped.next, new RegExp(`--allow-mint --short-to ${cp}`));
});

test("the mint fallback counts the PIRY-S still in Kuru: a partial short sale is PARTIAL, not HEDGED", async () => {
  const sim = new Sim();
  thinAtSwap(sim, SHORT_MARKET, 199n * U);
  const r = await hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true }));
  assert.equal(r.status, "PARTIAL");
  assert.equal(r.after?.netLong, "199");
  assert.equal(r.after?.claimsShort, "1");
  assert.deepEqual(r.reconciliation?.short, { mintedClaims: "200", soldOrSentClaims: "199", stillHeldClaims: "1" });
  assert.deepEqual(r.reconciliation?.leftovers, [{ token: "PIRY-S", where: "Kuru trading balance", amount: "1" }]);
  assert.match(r.reconciliation!.recovery.join(" "), /1 PIRY-S/);
  assert.match(r.reconciliation!.recovery.join(" "), /mm piry position/);
  const p = await agrees(sim, { short: true }, r);
  assert.equal(p.claims.shortKuru, "1");
  assert.equal(r.after?.spentUsdc, "90.55");
});

test("a full short sale still reports HEDGED with the real net outlay and no leftovers", async () => {
  const sim = new Sim();
  const r = await hedge(deps(sim, { short: true }), input({ maxPremium: 200n * U, allowMint: true }));
  assert.equal(r.status, "HEDGED");
  assert.equal(r.after?.spentUsdc, "90");
  assert.deepEqual(r.reconciliation?.short, { mintedClaims: "200", soldOrSentClaims: "200", stillHeldClaims: "0" });
  assert.deepEqual(r.reconciliation?.leftovers, []);
  await agrees(sim, { short: true }, r);
});

test("HEDGED is never reported while net coverage is below the request, for every fill that still meets the floor", async () => {
  for (const depth of [199n, 190n, 181n, 200n, 250n]) {
    const buy = new Sim();
    thinAtSwap(buy, LONG_MARKET, depth * U);
    const b = await hedge(deps(buy, { long: true }), input({ slippageBps: 1000 }));
    assert.equal(b.status, depth >= 200n ? "HEDGED" : "PARTIAL", `buy depth ${depth}`);
    await agrees(buy, { long: true }, b);

    const mint = new Sim();
    thinAtSwap(mint, SHORT_MARKET, depth * U);
    const m = await hedge(deps(mint, { short: true }), input({ maxPremium: 200n * U, allowMint: true, slippageBps: 1000 }));
    assert.equal(m.status, depth >= 200n ? "HEDGED" : "PARTIAL", `mint depth ${depth}`);
    await agrees(mint, { short: true }, m);
  }
});

test("leftovers also list PIRY-L and PIRY-S reserved by open Kuru orders, which do not count toward coverage", async () => {
  const sim = new Sim();
  sim.kuruRoot = 7n;
  sim.reserved = { usdc: 0n, long: 5n * U, short: 2n * U };
  const r = await hedge(deps(sim, { long: true }), input({ maxPremium: 100n * U }));
  const where = r.reconciliation!.leftovers.map((l) => `${l.token}:${l.where}`);
  assert.ok(where.includes("PIRY-L:Kuru, reserved by open orders"));
  assert.ok(where.includes("PIRY-S:Kuru, reserved by open orders"));
  assert.match(r.reconciliation!.recovery.join(" "), /reserved/);
});

test("unwind --min-proceeds is a total floor: merge-only below it is refused before any write", async () => {
  const sim = new Sim();
  sim.bal.long = 10n * U;
  sim.bal.short = 10n * U;
  const e = await rejects(unwind(deps(sim), { claims: null, method: "merge", slippageBps: 100, minProceeds: 11n * U }));
  assert.equal(e.code, "PROCEEDS_BELOW_MIN");
  assert.match(e.message, /merg/i);
  assert.equal(sim.sent.length, 0);
  const ok = await unwind(deps(sim), { claims: null, method: "merge", slippageBps: 100, minProceeds: 10n * U });
  assert.equal(ok.expectedProceedsUsdc, "10");
  assert.equal(ok.mergeProceedsUsdc, "10");
  assert.equal(ok.saleProceedsUsdc, "0");
  assert.equal(ok.receivedUsdc, "10");
});

test("unwind combines merge and sale proceeds against the floor, in the check, the swap floor and the summary", async () => {
  const mixed = () => { const s = new Sim(); s.bal.long = 150n * U; s.bal.short = 50n * U; return s; };
  const refused = mixed();
  const e = await rejects(unwind(deps(refused, { long: true }), { claims: null, method: "auto", slippageBps: 100, minProceeds: 96n * U }));
  assert.equal(e.code, "PROCEEDS_BELOW_MIN");
  assert.equal(refused.sent.length, 0);

  const lowFloor = mixed();
  const r = await unwind(deps(lowFloor, { long: true }), { claims: null, method: "auto", slippageBps: 100, minProceeds: 60n * U });
  assert.equal(r.mergeProceedsUsdc, "50");
  assert.equal(r.saleProceedsUsdc, "45");
  assert.equal(r.expectedProceedsUsdc, "95");
  assert.equal(r.receivedUsdc, "95");
  assert.deepEqual(lowFloor.sent.find((s) => s.fn === "swap")!.args.slice(1, 4), [false, 100n * U, 44_550_000n]);

  const exact = mixed();
  await unwind(deps(exact, { long: true }), { claims: null, method: "auto", slippageBps: 100, minProceeds: 95n * U });
  assert.deepEqual(exact.sent.find((s) => s.fn === "swap")!.args.slice(1, 4), [false, 100n * U, 45n * U]);
});

test("an unwind sale that fills partially lists the PIRY-L left in Kuru and agrees with position", async () => {
  const sim = new Sim();
  sim.bal.long = 100n * U;
  thinAtSwap(sim, LONG_MARKET, 99n * U);
  const r = await unwind(deps(sim, { long: true }), { claims: null, method: "sell", slippageBps: 1000, minProceeds: null });
  assert.equal(r.longClaimsLeft, "1");
  assert.deepEqual(r.leftovers, [{ token: "PIRY-L", where: "Kuru trading balance", amount: "1" }]);
  const p = await position(sim.reader, sim.config({ long: true }), OWNER);
  assert.equal(p.claims.longKuru, "1");
  assert.deepEqual(fns(sim), ["approve", "deposit", "swap", "withdraw"]);
});
