import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RPC_URL, KURU_ACCOUNT_CORE, SERIES, resolveConfig } from "../src/config.js";
import { PiryError } from "../src/errors.js";

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PiryError).code; } return null; };
const MARKET = "0x2222222222222222222222222222222222222222";

test("defaults: public Monad RPC, no Kuru markets", () => {
  const c = resolveConfig();
  assert.equal(c.rpcUrl, new URL(DEFAULT_RPC_URL).toString());
  assert.equal(c.kuruMarket, null);
  assert.equal(c.kuruShortMarket, null);
  assert.equal(c.series.market, SERIES.market);
});

test("environment feeds config; explicit input wins", () => {
  const env = { PIRY_KURU_MARKET: MARKET, PIRY_KURU_SHORT_MARKET: "0x3333333333333333333333333333333333333333", PIRY_RPC_URL: "https://rpc.example.org" };
  const c = resolveConfig({ env });
  assert.equal(c.kuruMarket, MARKET);
  assert.equal(c.kuruShortMarket, "0x3333333333333333333333333333333333333333");
  assert.equal(c.rpcUrl, "https://rpc.example.org/");
  assert.equal(resolveConfig({ env, kuruMarket: "0x4444444444444444444444444444444444444444" }).kuruMarket, "0x4444444444444444444444444444444444444444");
  assert.equal(resolveConfig({ env: { PIRY_KURU_MARKET: "  " } }).kuruMarket, null);
});

test("rejects plaintext non-loopback RPC, bad URLs and bad addresses", () => {
  assert.equal(code(() => resolveConfig({ rpcUrl: "http://rpc.example.org" })), "INVALID_CONFIG");
  assert.equal(code(() => resolveConfig({ rpcUrl: "not a url" })), "INVALID_CONFIG");
  assert.doesNotThrow(() => resolveConfig({ rpcUrl: "http://127.0.0.1:8545" }));
  assert.equal(code(() => resolveConfig({ kuruMarket: "0x123" })), "INVALID_CONFIG");
});

test("a Kuru market cannot be a Piry or Kuru account contract", () => {
  for (const addr of [SERIES.market, SERIES.longClaim, SERIES.shortClaim, SERIES.collateral, SERIES.markFeed, KURU_ACCOUNT_CORE, "0x0000000000000000000000000000000000000000"]) {
    assert.equal(code(() => resolveConfig({ kuruMarket: addr })), "INVALID_CONFIG", addr);
    assert.equal(code(() => resolveConfig({ kuruShortMarket: addr })), "INVALID_CONFIG", addr);
  }
});
