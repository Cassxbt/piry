import assert from "node:assert/strict";
import { test } from "node:test";
import { SERIES } from "../src/config.js";
import { redeem } from "../src/redeem.js";
import { LONG_MARKET, SHORT_MARKET, Sim } from "./sim.js";

const U = 1_000_000n;
const both = { long: true, short: true } as const;
const deps = (sim: Sim) => ({ client: sim.reader, config: sim.config(both), wallet: sim.wallet });
const fns = (sim: Sim) => sim.sent.map((s) => s.fn);
const settled = () => {
  const sim = new Sim();
  sim.settled = true;
  sim.settlementPrice = 3_500_000n;
  return sim;
};

test("wallet-held claims redeem while the short book points at the wrong token", async () => {
  const sim = settled();
  sim.bal.long = 10n * U;
  sim.books.get(SHORT_MARKET.toLowerCase())!.base = SERIES.longClaim;
  const r = await redeem(deps(sim), { minPayout: null });
  assert.equal(r.receivedUsdc, "5");
  assert.deepEqual(fns(sim), ["redeem"]);
  assert.deepEqual(sim.bookReads, []);
});

test("wallet-held claims redeem with both books unverified, mismatched and unreachable, and no book is ever read", async () => {
  const sim = settled();
  sim.bal.long = 10n * U;
  sim.bal.short = 4n * U;
  sim.unverified.add(LONG_MARKET.toLowerCase());
  sim.unverified.add(SHORT_MARKET.toLowerCase());
  sim.books.get(LONG_MARKET.toLowerCase())!.base = SERIES.collateral;
  sim.booksDown = true;
  const r = await redeem(deps(sim), { minPayout: null });
  assert.equal(r.redeemedLong, "10");
  assert.equal(r.redeemedShort, "4");
  assert.deepEqual(fns(sim), ["redeem"]);
  assert.deepEqual(sim.bookReads, []);
});

test("wallet-only redeem does not consult Kuru's price limiter, so a stale price cannot block it", async () => {
  const sim = settled();
  sim.bal.long = 10n * U;
  sim.priceStale = true;
  await redeem(deps(sim), { minPayout: null });
  assert.deepEqual(fns(sim), ["redeem"]);
  assert.deepEqual(sim.limiterChecked, []);
});

test("claims held in the Kuru account are withdrawn and redeemed even though both books are closed", async () => {
  const sim = settled();
  sim.bal.long = 10n * U;
  sim.kuruRoot = 7n;
  sim.kuruBal.long = 100n * U;
  sim.kuruBal.short = 20n * U;
  sim.booksDown = true;
  sim.unverified.add(LONG_MARKET.toLowerCase());
  const r = await redeem(deps(sim), { minPayout: null });
  assert.deepEqual(fns(sim), ["withdraw", "withdraw", "redeem"]);
  assert.equal(r.redeemedLong, "110");
  assert.equal(r.redeemedShort, "20");
  assert.deepEqual(sim.bookReads, []);
  assert.equal(sim.limiterChecked.length, 2);
});

test("if the Kuru account cannot be read, wallet-held claims still redeem and the result says Kuru was skipped", async () => {
  const sim = settled();
  sim.bal.long = 10n * U;
  sim.kuruDown = true;
  const r = await redeem(deps(sim), { minPayout: null });
  assert.deepEqual(fns(sim), ["redeem"]);
  assert.match(r.warnings.join(" "), /Kuru/);
  assert.match(r.warnings.join(" "), /wallet-held/);
});

test("with nothing in the wallet, an unreadable Kuru account is an error, not 'you hold nothing'", async () => {
  const sim = settled();
  sim.kuruDown = true;
  await assert.rejects(redeem(deps(sim), { minPayout: null }), /Kuru AccountCore unreachable/);
  assert.equal(sim.sent.length, 0);
});
