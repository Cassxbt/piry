import assert from "node:assert/strict";
import { test } from "node:test";
import { demoDataset, demoTerms } from "../demo.js";
import { indexIdentity, validateDataset } from "../validation.js";

const now = demoDataset.publishedAt + 30;
const copy = () => structuredClone(demoDataset);

test("explicit DEMO fixture yields fixed-point mean, rounded down", () => {
  const result = validateDataset(copy(), demoTerms, now);
  assert.equal(result.price, 2333333n);
  assert.equal(result.publishedAt, demoDataset.publishedAt);
  assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.match(result.canonicalEvidence, /DEMO/);
});

test("order and JSON key order do not affect evidence", () => {
  const data = copy();
  data.observations.reverse();
  data.hardware = { region: data.hardware.region, gpuCount: data.hardware.gpuCount,
    memoryGiB: data.hardware.memoryGiB, model: data.hardware.model };
  const result = validateDataset(data, demoTerms, now);
  assert.deepEqual(result, validateDataset(copy(), demoTerms, now));
});

for (const [field, value] of Object.entries({
  schemaVersion: 2, mode: "LIVE", sourceId: "other", datasetId: "other",
  currency: "EUR", units: "USD/instance-hour", priceDecimals: 18, slotSeconds: 1800,
  indexId: `0x${"aa".repeat(32)}`, specHash: `0x${"bb".repeat(32)}`,
  periodStart: demoTerms.periodStart - 3600, periodEnd: demoTerms.periodEnd + 3600,
})) {
  test(`reject mismatched ${field}`, () => {
    const data: Record<string, unknown> = copy();
    data[field] = value;
    assert.throws(() => validateDataset(data, demoTerms, now), /binding|schema/);
  });
}

for (const [field, value] of Object.entries({ model: "H100", memoryGiB: 40, gpuCount: 2, region: "other" })) {
  test(`reject mismatched hardware ${field}`, () => {
    const data = copy();
    Object.assign(data.hardware, { [field]: value });
    assert.throws(() => validateDataset(data, demoTerms, now), /hardware|binding/);
  });
}

test("every methodology input changes the spec hash", () => {
  const initial = indexIdentity(demoTerms);
  for (const terms of [
    { ...demoTerms, sourceId: "another-demo" },
    { ...demoTerms, datasetId: "another-dataset" },
    { ...demoTerms, slotSeconds: 1800 },
    { ...demoTerms, priceDecimals: 5 },
    { ...demoTerms, hardware: { ...demoTerms.hardware, memoryGiB: 40 } },
  ]) assert.notEqual(indexIdentity(terms).specHash, initial.specHash);
});

for (const [name, change, pattern] of [
  ["missing", (d: typeof demoDataset) => d.observations.pop(), /complete/],
  ["duplicate", (d: typeof demoDataset) => { d.observations[1] = { ...d.observations[0] }; }, /duplicate/],
  ["extra", (d: typeof demoDataset) => d.observations.push({ ...d.observations[0] }), /complete/],
  ["before period", (d: typeof demoDataset) => { d.observations[0].slotStart -= 3600; }, /range/],
  ["at end", (d: typeof demoDataset) => { d.observations[0].slotStart = d.periodEnd; }, /range/],
  ["off grid", (d: typeof demoDataset) => { d.observations[0].slotStart += 1; }, /grid/],
  ["observation before slot", (d: typeof demoDataset) => { d.observations[0].observedAt = d.periodStart - 1; }, /observation/],
  ["stale slot observation", (d: typeof demoDataset) => { d.observations[0].observedAt += 3600; }, /observation/],
  ["future observation", (d: typeof demoDataset) => { d.observations[0].observedAt = now + 1; }, /observation/],
] as const) {
  test(`reject ${name}`, () => {
    const data = copy(); change(data);
    assert.throws(() => validateDataset(data, demoTerms, now), pattern);
  });
}

test("reject incomplete future period and publication before period end", () => {
  assert.throws(() => validateDataset(copy(), demoTerms, demoTerms.periodEnd - 1), /future|completed/);
  const data = copy(); data.publishedAt = demoTerms.periodEnd - 1;
  assert.throws(() => validateDataset(data, demoTerms, now), /publication/);
});

test("publication freshness boundaries are inclusive; future and stale rejected", () => {
  validateDataset(copy(), demoTerms, demoDataset.publishedAt);
  validateDataset(copy(), demoTerms, demoDataset.publishedAt + demoTerms.maxPublicationAgeSeconds);
  assert.throws(() => validateDataset(copy(), demoTerms, demoDataset.publishedAt - 1), /publication/);
  assert.throws(() => validateDataset(copy(), demoTerms,
    demoDataset.publishedAt + demoTerms.maxPublicationAgeSeconds + 1), /publication/);
});

for (const price of [2, 2.1, -1, null, "", "01", "-1", "1.0", "1e6", " 1", "1 ", "0x10", "1".repeat(79)]) {
  test(`reject noncanonical or oversized price ${JSON.stringify(price)}`, () => {
    const data = copy(); Object.assign(data.observations[0], { price });
    assert.throws(() => validateDataset(data, demoTerms, now), /price/);
  });
}

test("bigint arithmetic retains values beyond JS safe range and bounds accumulation", () => {
  const data = copy();
  data.observations.forEach(row => { row.price = "9007199254740993"; });
  assert.equal(validateDataset(data, demoTerms, now).price, 9007199254740993n);
  const max = ((1n << 256n) - 1n) / 168n;
  data.observations.forEach(row => { row.price = max.toString(); });
  assert.equal(validateDataset(data, demoTerms, now).price, max);
  data.observations[0].price = (max + 1n).toString();
  assert.throws(() => validateDataset(data, demoTerms, now), /price/);
});

test("zero prices are valid; evidence binds each row even if the mean is identical", () => {
  const data = copy();
  data.observations.forEach(row => { row.price = "0"; });
  assert.equal(validateDataset(data, demoTerms, now).price, 0n);
  const changed = copy();
  changed.observations[0].price = "2000001";
  changed.observations[1].price = "2999999";
  const a = validateDataset(copy(), demoTerms, now);
  const b = validateDataset(changed, demoTerms, now);
  assert.equal(a.price, b.price);
  assert.notEqual(a.evidenceHash, b.evidenceHash);
});

test("reject unsafe and malformed times, unbounded slots and non-DEMO terms", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, NaN, Infinity, "1", null]) {
    const data = copy(); Object.assign(data, { publishedAt: value });
    assert.throws(() => validateDataset(data, demoTerms, now), /integer/);
  }
  for (const terms of [
    { ...demoTerms, slotSeconds: 0 },
    { ...demoTerms, periodEnd: demoTerms.periodStart + 1 },
    { ...demoTerms, periodEnd: demoTerms.periodStart + 3600 * 169 },
    { ...demoTerms, maxPublicationAgeSeconds: 0 },
    { ...demoTerms, priceDecimals: 19 },
    { ...demoTerms, periodStart: Number.MAX_SAFE_INTEGER + 1 },
    { ...demoTerms, mode: "LIVE" },
  ]) assert.throws(() => validateDataset(copy(), terms as typeof demoTerms, now));
  for (const data of [null, [], {}, { ...copy(), observations: null }]) {
    assert.throws(() => validateDataset(data, demoTerms, now));
  }
});

test("strict schema rejects unbound fields and missing fields", () => {
  assert.throws(() => validateDataset({ ...copy(), provider: "unbound" }, demoTerms, now), /schema/);
  const data = copy(); Object.assign(data.hardware, { tenancy: "shared" });
  assert.throws(() => validateDataset(data, demoTerms, now), /schema/);
});
