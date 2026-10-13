import assert from "node:assert/strict";
import { test } from "node:test";
import { readSeries } from "../src/chain.js";
import { resolveConfig } from "../src/config.js";
import { hedge } from "../src/hedge.js";
import { position } from "../src/position.js";
import { quote } from "../src/quote.js";
import { makeReader } from "../src/reader.js";
import { fetchComposite } from "../src/sources.js";
import type { Wallet } from "../src/tx.js";

// Read-only checks against Monad testnet. Opt in with PIRY_LIVE=1. The wallet below throws if anything tries to send.
const live = process.env.PIRY_LIVE === "1" ? test : test.skip;
const OWNER = "0x66d71a8612Fbf6ab69340Bf82aB431e1Ad30b5c3";
const mustNotSend: Wallet = { address: OWNER, send: async () => { throw new Error("live tests must not send"); } };
const WETH_MARKET = "0x9d187971B64505Ac81f12c5FD2ac9c5247Ec62F3";

live("live series state matches the deployed Piry contracts", async () => {
  const config = resolveConfig({ env: process.env });
  const s = await readSeries(makeReader(config.rpcUrl), config);
  assert.equal(s.band.lower, 2_500_000n);
  assert.equal(s.band.upper, 4_500_000n);
  assert.equal(s.collateralDecimals, 6);
  assert.equal(s.periodEnd, 1_792_411_200n);
  assert.ok(s.mark && s.mark.indexPrice >= 500_000n && s.mark.indexPrice <= 20_000_000n);
  assert.ok(s.mark!.shortAnswer !== null, "short feed is wired to the long feed");
  assert.ok(s.mark!.answer + s.mark!.shortAnswer! <= 100_000_001n, "short = 1 - long");
});

live("live quote, position and hedge preview send nothing", async () => {
  const config = resolveConfig({ env: process.env });
  const client = makeReader(config.rpcUrl);
  const q = await quote(client, config, 500_000_000n);
  assert.equal(q.hedge?.claims, "1000");
  const p = await position(client, config, OWNER);
  assert.ok(["OPEN", "AWAITING_SETTLEMENT", "SETTLED", "SETTLED_BY_FALLBACK"].includes(p.series.status));
  const h = await hedge({ client, config, wallet: mustNotSend }, { gpuHoursMicro: 10_000_000n, maxPremium: null, slippageBps: 100, allowMint: true, shortTo: null });
  assert.ok(["PREVIEW", "ALREADY_HEDGED", "SERIES_CLOSED"].includes(h.status) || h.status === "UNAVAILABLE");
  assert.equal(h.steps.length, 0);
});

live("live: an existing Kuru market for another pair is refused", async () => {
  const config = resolveConfig({ kuruMarket: WETH_MARKET });
  await assert.rejects(hedge({ client: makeReader(config.rpcUrl), config, wallet: mustNotSend }, { gpuHoursMicro: 10_000_000n, maxPremium: null, slippageBps: 100, allowMint: false, shortTo: null }), { code: "KURU_MARKET_MISMATCH" });
});

live("live public sources reproduce an index near the on-chain mark", async () => {
  const config = resolveConfig({ env: process.env });
  const [composite, s] = await Promise.all([fetchComposite(), readSeries(makeReader(config.rpcUrl), config)]);
  assert.ok(composite.validSources >= 3, JSON.stringify(composite.readings));
  const direct = Number(composite.indexUsd);
  const onchain = Number(s.mark!.indexPrice) / 1e6;
  assert.ok(Math.abs(direct - onchain) / onchain < 0.1, `direct ${direct} vs on-chain ${onchain}`);
});
