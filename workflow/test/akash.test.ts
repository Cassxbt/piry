import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { demoDataset, demoTerms } from "../demo.js";
import { canonicalJson, numberToUnits, validateAkashEvidence, validateAkashResponse } from "../akash.js";
import { encodeMarkReport, encodeMarketReport } from "../report.js";
import { AKASH_METHODOLOGY, indexIdentity, validateDataset, validateTerms, type AkashTerms } from "../validation.js";
import { akashTerms, h100, liveGpuPrices, periodEnd, type Body } from "./akash-fixtures.js";

const settleAt = periodEnd + 30;
const markAt = periodEnd - 6 * 3600 + 17;
const settle = (body: unknown, terms: AkashTerms = akashTerms, now = settleAt) => validateAkashResponse(body, terms, now, "settlement");
const mark = (body: unknown, terms: AkashTerms = akashTerms, now = markAt) => validateAkashResponse(body, terms, now, "mark");
const mutated = (change: (body: Body) => void) => { const body = liveGpuPrices(); change(body); return body; };

test("DEMO identity and evidence stay byte-identical", () => {
  assert.deepEqual(indexIdentity(demoTerms), {
    indexId: "0x75ecbd9bc05261b6d94a00390add4244481edf2002b10b46b0a715a49923bff5",
    specHash: "0x2e3085be8964333511930a34fbd0c4bb7f0b482becfa825ca1f6f580930f6703",
  });
  assert.equal(validateDataset(demoDataset, demoTerms, demoDataset.publishedAt + 30).evidenceHash,
    "0x8a822faf00c65e7fd863ac0be501972ec0c1e9999412887ca30504c21aefc90a");
});

test("live H100 SXM5 response: weighted average 2.73 USD becomes 2730000 at six decimals", () => {
  const result = settle(liveGpuPrices());
  assert.equal(result.price, 2730000n);
  assert.equal(result.methodology, AKASH_METHODOLOGY);
  assert.equal(result.publishedAt, settleAt - 30);
  assert.equal(result.observedAt, result.publishedAt);
  assert.equal(result.slots, 1);
  assert.equal(result.evidenceHash, keccak256(toBytes(result.canonicalEvidence)));
  assert.equal(mark(liveGpuPrices(), { ...akashTerms, priceField: "med" }).price, 2560000n);
});

test("evidence is the canonical selector, price field, matched record verbatim and the floored observation minute", () => {
  const result = mark(liveGpuPrices());
  const evidence = JSON.parse(result.canonicalEvidence);
  assert.deepEqual(Object.keys(evidence), ["methodology", "model", "observedAt", "priceField", "selector"]);
  assert.equal(evidence.methodology, "akash-console-snapshot-v1");
  assert.deepEqual(evidence.selector, akashTerms.selector);
  assert.equal(evidence.priceField, "weightedAverage");
  assert.equal(evidence.observedAt, markAt - 17);
  assert.deepEqual(evidence.model, h100(liveGpuPrices()));
  assert.match(result.canonicalEvidence, /"price":\{"avg":2\.58,"currency":"USD","max":3\.16,"med":2\.56,"min":2\.04,"weightedAverage":2\.73\}/);
});

test("canonical JSON ignores key order at every depth and survives a __proto__ key", () => {
  assert.equal(canonicalJson({ b: [{ z: 1, a: 2 }], a: null }), '{"a":null,"b":[{"a":2,"z":1}]}');
  const body = liveGpuPrices();
  const record = h100(body);
  const reordered = { ...body, models: body.models.map((model: Body) => model === record
    ? Object.fromEntries(Object.entries(model).reverse().map(([key, value]) => [key, key === "price"
      ? Object.fromEntries(Object.entries(value as object).reverse()) : value])) : model) };
  assert.equal(mark(reordered).canonicalEvidence, mark(liveGpuPrices()).canonicalEvidence);
  const hostile = JSON.parse('{"a":1,"__proto__":{"x":1}}');
  assert.equal(canonicalJson(hostile), '{"__proto__":{"x":1},"a":1}');
});

test("unrelated fields and malformed other models are ignored by the schema", () => {
  const body = mutated(b => {
    b.extra = { anything: [1, 2] };
    b.models.push(null, 7, "x", { vendor: "nvidia", model: "h100" }, { ...h100(b), interface: "PCIe", price: null });
  });
  assert.equal(mark(body).price, 2730000n);
});

test("matched record extras are carried into the evidence without affecting validation", () => {
  const body = mutated(b => { h100(b).newField = { nested: [3, 1] }; });
  assert.match(mark(body).canonicalEvidence, /"newField":\{"nested":\[3,1\]\}/);
});

test("one snapshot per minute: identical within a minute, different across minutes", () => {
  const minute = markAt - 17;
  const a = mark(liveGpuPrices(), akashTerms, minute);
  assert.equal(mark(liveGpuPrices(), akashTerms, minute + 59).canonicalEvidence, a.canonicalEvidence);
  assert.notEqual(mark(liveGpuPrices(), akashTerms, minute + 60).evidenceHash, a.evidenceHash);
  assert.equal(mark(liveGpuPrices(), akashTerms, minute + 60).observedAt, minute + 60);
});

for (const [name, value, expected, decimals] of [
  ["a plain decimal", 2.73, 2730000n, 6],
  ["a value float multiplication gets wrong", 4.35, 435n, 2],
  ["float sum noise", 0.1 + 0.2, 300000n, 6],
  ["more digits than the scale are floored", 2.7399999, 2739999n, 6],
  ["an integer", 3, 3000000n, 6],
  ["zero decimals floor", 2.99, 2n, 0],
  ["exponent underflow floors to zero", 1e-7, 0n, 6],
  ["a small exponent value", 1.5e-7, 15n, 8],
  ["a large exponent value", 1.5e21, 15n * 10n ** 26n, 6],
  ["the maximum scale", 1.25, 1250000000000000000n, 18],
] as const) {
  test(`number conversion: ${name}`, () => assert.equal(numberToUnits(value, decimals), expected));
}

for (const [name, value] of [
  ["NaN", NaN], ["infinity", Infinity], ["negative", -2.73], ["negative zero", -0], ["zero", 0],
  ["a string", "2.73"], ["null", null], ["a boolean", true], ["undefined", undefined], ["a bigint", 273n], ["an object", {}],
  ["uint256 overflow through the exponent", 1e300],
] as const) {
  test(`number conversion rejects ${name}`, () => assert.throws(() => numberToUnits(value, 18), /price|number|uint256/));
}

for (const [name, change, pattern] of [
  ["an unmatched selector", (b: Body) => { h100(b).model = "h200"; }, /selector|model/],
  ["a different interface", (b: Body) => { h100(b).interface = "PCIe"; }, /selector|model/],
  ["a different memory size", (b: Body) => { h100(b).ram = "40Gi"; }, /selector|model/],
  ["a different vendor", (b: Body) => { h100(b).vendor = "amd"; }, /selector|model/],
  ["a duplicated matching model", (b: Body) => { b.models.push(structuredClone(h100(b))); }, /ambiguous|exactly one/],
  ["no models array", (b: Body) => { b.models = {}; }, /models/],
  ["a missing models array", (b: Body) => { delete b.models; }, /models/],
  ["a non-USD currency", (b: Body) => { h100(b).price.currency = "uakt"; }, /currency/],
  ["a missing currency", (b: Body) => { delete h100(b).price.currency; }, /currency/],
  ["a null price object", (b: Body) => { h100(b).price = null; }, /price/],
  ["a missing price object", (b: Body) => { delete h100(b).price; }, /price/],
  ["a string price", (b: Body) => { h100(b).price.weightedAverage = "2.73"; }, /price/],
  ["a null price", (b: Body) => { h100(b).price.weightedAverage = null; }, /price/],
  ["a zero price", (b: Body) => { h100(b).price.weightedAverage = 0; }, /price/],
  ["a negative price", (b: Body) => { h100(b).price.weightedAverage = -2.73; }, /price/],
  ["a missing price field", (b: Body) => { delete h100(b).price.weightedAverage; }, /price/],
  ["a price below the sanity floor", (b: Body) => { h100(b).price.weightedAverage = 0.49; }, /sanity/],
  ["a price above the sanity ceiling", (b: Body) => { h100(b).price.weightedAverage = 20.01; }, /sanity/],
  ["a price that floors below the sanity floor", (b: Body) => { h100(b).price.weightedAverage = 0.4999999; }, /sanity/],
  ["a thin provider set", (b: Body) => { h100(b).providerAvailability.total = 1; }, /provider/],
  ["a missing provider count", (b: Body) => { delete h100(b).providerAvailability.total; }, /provider/],
  ["a fractional provider count", (b: Body) => { h100(b).providerAvailability.total = 2.5; }, /provider/],
  ["a string provider count", (b: Body) => { h100(b).providerAvailability.total = "4"; }, /provider/],
  ["a missing providerAvailability", (b: Body) => { delete h100(b).providerAvailability; }, /provider/],
] as const) {
  test(`reject ${name}`, () => {
    assert.throws(() => settle(mutated(change)), pattern);
    assert.throws(() => mark(mutated(change)), pattern);
  });
}

test("sanity bounds and provider minimum are inclusive", () => {
  const field = (price: number) => mutated(b => { h100(b).price.weightedAverage = price; });
  assert.equal(mark(field(0.5)).price, 500000n);
  assert.equal(mark(field(20)).price, 20000000n);
  assert.equal(mark(mutated(b => { h100(b).providerAvailability.total = 2; })).price, 2730000n);
});

test("reject non-object responses", () => {
  for (const body of [null, [], "x", 1, true, undefined]) assert.throws(() => mark(body), /schema|object/);
});

test("settlement is a snapshot at expiry: not before periodEnd, not after the publication window", () => {
  assert.throws(() => settle(liveGpuPrices(), akashTerms, periodEnd - 1), /settlement/);
  assert.throws(() => settle(liveGpuPrices(), akashTerms, periodEnd - 3600), /settlement/);
  assert.equal(settle(liveGpuPrices(), akashTerms, periodEnd).publishedAt, periodEnd);
  assert.equal(settle(liveGpuPrices(), akashTerms, periodEnd + akashTerms.maxPublicationAgeSeconds).price, 2730000n);
  assert.throws(() => settle(liveGpuPrices(), akashTerms, periodEnd + akashTerms.maxPublicationAgeSeconds + 1), /settlement/);
});

test("settlement requires the floored minute to reach periodEnd so the contract's publishedAt >= periodEnd holds", () => {
  const offGrid = { ...akashTerms, periodEnd: periodEnd + 20 };
  assert.throws(() => settle(liveGpuPrices(), offGrid, periodEnd + 30), /settlement/);
  assert.equal(settle(liveGpuPrices(), offGrid, periodEnd + 60).publishedAt, periodEnd + 60);
});

test("marks have no time window", () => {
  for (const now of [akashTerms.periodStart - 86400, akashTerms.periodStart, periodEnd, periodEnd + 100000]) {
    assert.equal(mark(liveGpuPrices(), akashTerms, now).price, 2730000n);
  }
});

test("evidence re-validates against the terms and rejects any tampering", () => {
  const settlement = settle(liveGpuPrices());
  assert.deepEqual(validateAkashEvidence(settlement.canonicalEvidence, akashTerms, settleAt, "settlement"), settlement);
  assert.deepEqual(validateAkashEvidence(settlement.canonicalEvidence, akashTerms, settleAt + 5, "settlement"), settlement);
  const evidence = JSON.parse(settlement.canonicalEvidence);
  for (const [name, change] of [
    ["selector", (e: Body) => { e.selector.model = "h200"; }],
    ["model record", (e: Body) => { e.model.model = "h200"; }],
    ["price field", (e: Body) => { e.priceField = "med"; }],
    ["methodology", (e: Body) => { e.methodology = "other"; }],
    ["observation time", (e: Body) => { e.observedAt += 60; }],
    ["extra field", (e: Body) => { e.extra = 1; }],
    ["missing field", (e: Body) => { delete e.observedAt; }],
  ] as const) {
    const tampered = structuredClone(evidence);
    change(tampered);
    assert.throws(() => validateAkashEvidence(JSON.stringify(tampered), akashTerms, settleAt, "settlement"), /evidence|schema|selector|sanity/, name);
  }
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(evidence).reverse()));
  assert.throws(() => validateAkashEvidence(reordered, akashTerms, settleAt, "settlement"), /canonical/);
  assert.throws(() => validateAkashEvidence("{", akashTerms, settleAt, "settlement"));
  assert.throws(() => validateAkashEvidence(settlement.canonicalEvidence, akashTerms, periodEnd - 1, "settlement"), /settlement/);
});

test("AKASH identity is deterministic, distinct from DEMO and changes with every methodology input", () => {
  const initial = indexIdentity(akashTerms);
  assert.deepEqual(indexIdentity(structuredClone(akashTerms)), initial);
  assert.deepEqual(indexIdentity({ ...akashTerms, periodStart: 1, periodEnd: 2, maxPublicationAgeSeconds: 5 }), initial);
  assert.notDeepEqual(initial, indexIdentity(demoTerms));
  for (const terms of [
    { ...akashTerms, priceField: "med" },
    { ...akashTerms, minProviders: 3 },
    { ...akashTerms, priceDecimals: 5 },
    { ...akashTerms, sanityBounds: { ...akashTerms.sanityBounds, min: "0.51" } },
    { ...akashTerms, sanityBounds: { ...akashTerms.sanityBounds, max: "20.01" } },
    { ...akashTerms, selector: { ...akashTerms.selector, model: "h200" } },
    { ...akashTerms, selector: { ...akashTerms.selector, ram: "40Gi" } },
    { ...akashTerms, selector: { ...akashTerms.selector, interface: "PCIe" } },
    { ...akashTerms, selector: { ...akashTerms.selector, vendor: "amd" } },
  ] as AkashTerms[]) {
    const changed = indexIdentity(terms);
    assert.notEqual(changed.specHash, initial.specHash);
    if (terms.priceField !== akashTerms.priceField || terms.selector !== akashTerms.selector) assert.notEqual(changed.indexId, initial.indexId);
  }
  assert.equal(indexIdentity({ ...akashTerms, sanityBounds: { min: "0.5", max: "20" } }).specHash, initial.specHash);
});

test("AKASH identity matches the pinned values", () => {
  assert.deepEqual(indexIdentity(akashTerms), {
    indexId: "0x925668dc4bb6f771e257b3338a9e604d8bbc1e3dd164774dc311063e8a78bd2a",
    specHash: "0x5b2c6a765b6ad43bef90ae33c6fd93f97edb1a1c91011af58ea39cc13e92046c",
  });
});

for (const [name, terms] of [
  ["a foreign source", { ...akashTerms, sourceId: "other" }],
  ["an unknown price field", { ...akashTerms, priceField: "avg" }],
  ["zero providers", { ...akashTerms, minProviders: 0 }],
  ["fractional providers", { ...akashTerms, minProviders: 1.5 }],
  ["an excessive provider minimum", { ...akashTerms, minProviders: 1001 }],
  ["a zero sanity floor", { ...akashTerms, sanityBounds: { min: "0", max: "20.00" } }],
  ["an inverted sanity range", { ...akashTerms, sanityBounds: { min: "20.00", max: "0.50" } }],
  ["an empty sanity range", { ...akashTerms, sanityBounds: { min: "1.00", max: "1.00" } }],
  ["a number sanity bound", { ...akashTerms, sanityBounds: { min: 0.5, max: "20.00" } }],
  ["an exponent sanity bound", { ...akashTerms, sanityBounds: { min: "5e-1", max: "20.00" } }],
  ["a leading zero sanity bound", { ...akashTerms, sanityBounds: { min: "00.50", max: "20.00" } }],
  ["a negative sanity bound", { ...akashTerms, sanityBounds: { min: "-1", max: "20.00" } }],
  ["a sanity bound finer than the price scale", { ...akashTerms, sanityBounds: { min: "0.5000001", max: "20.00" } }],
  ["an unknown sanity key", { ...akashTerms, sanityBounds: { min: "0.50", max: "20.00", mid: "1" } }],
  ["decimals above 18", { ...akashTerms, priceDecimals: 19 }],
  ["an empty period", { ...akashTerms, periodEnd: akashTerms.periodStart }],
  ["a zero publication window", { ...akashTerms, maxPublicationAgeSeconds: 0 }],
  ["an unsafe period", { ...akashTerms, periodStart: Number.MAX_SAFE_INTEGER + 1 }],
  ["an invalid selector label", { ...akashTerms, selector: { ...akashTerms.selector, model: "" } }],
  ["an extra selector key", { ...akashTerms, selector: { ...akashTerms.selector, extra: "x" } }],
  ["a missing selector key", { ...akashTerms, selector: { vendor: "nvidia", model: "h100", ram: "80Gi" } }],
  ["a foreign mode", { ...akashTerms, mode: "LIVE" }],
] as const) {
  test(`terms reject ${name}`, () => {
    assert.throws(() => validateTerms(terms as unknown as AkashTerms));
    assert.throws(() => indexIdentity(terms as unknown as AkashTerms));
  });
}

const settlementDestination = { market: "0x1111111111111111111111111111111111111111" as const, chainId: 10143n };
const markDestination = { feed: "0x3333333333333333333333333333333333333333" as const, chainId: 10143n };

test("settlement report is the 320-byte ComputeMarket layout carrying the AKASH identity and snapshot", () => {
  const result = settle(liveGpuPrices());
  const payload = encodeMarketReport(result, akashTerms, settlementDestination);
  assert.equal((payload.length - 2) / 2, 320);
  const decoded = decodeAbiParameters(parseAbiParameters(
    "address,uint256,bytes32,bytes32,uint8,uint64,uint64,uint256,uint64,bytes32"), payload);
  const identity = indexIdentity(akashTerms);
  assert.deepEqual(decoded, [settlementDestination.market, 10143n, identity.indexId, identity.specHash, 6,
    BigInt(akashTerms.periodStart), BigInt(periodEnd), 2730000n, BigInt(periodEnd + 0), result.evidenceHash]);
});

test("mark report is the 192-byte feed layout with the observation time reduced by the margin", () => {
  const result = mark(liveGpuPrices());
  const payload = encodeMarkReport(result, akashTerms, markDestination, 15);
  assert.equal((payload.length - 2) / 2, 192);
  const decoded = decodeAbiParameters(parseAbiParameters("address,uint256,bytes32,uint256,uint64,bytes32"), payload);
  assert.deepEqual(decoded, [markDestination.feed, 10143n, indexIdentity(akashTerms).indexId, 2730000n,
    BigInt(result.observedAt - 15), result.evidenceHash]);
});

test("AKASH reports cannot relabel validated evidence, price or time", () => {
  const result = settle(liveGpuPrices());
  const changedTerms = { ...akashTerms, minProviders: 3 };
  assert.throws(() => encodeMarketReport(result, { ...akashTerms, priceField: "med" }, settlementDestination), /evidence|binding/);
  assert.notDeepEqual(indexIdentity(changedTerms), indexIdentity(akashTerms));
  assert.throws(() => encodeMarketReport({ ...result, price: 1n }, akashTerms, settlementDestination), /evidence|binding/);
  assert.throws(() => encodeMarketReport({ ...result, publishedAt: result.publishedAt + 60 }, akashTerms, settlementDestination), /evidence|binding|settlement/);
  assert.throws(() => encodeMarketReport({ ...result, evidenceHash: `0x${"aa".repeat(32)}` }, akashTerms, settlementDestination), /evidence|binding/);
  const early = mark(liveGpuPrices(), akashTerms, periodEnd - 3600);
  assert.throws(() => encodeMarketReport(early, akashTerms, settlementDestination), /settlement/);
  assert.throws(() => encodeMarkReport({ ...early, observedAt: early.observedAt + 1 }, akashTerms, markDestination), /evidence|binding/);
});
