import assert from "node:assert/strict";
import { test } from "node:test";
import { demoDataset, demoTerms } from "../demo.js";
import { validateDataset, validateMarkDataset, validatePartialDataset } from "../validation.js";
import { partialDataset, spotDataset } from "./fixtures.js";

const { periodStart, slotSeconds: slot } = demoTerms;
const now = (data: { publishedAt: number }) => data.publishedAt + 30;
const methodology = (evidence: string) => JSON.parse(evidence).methodology;

test("before the period the mark is the latest completed slot's observation, labelled pre-period-spot-v1", () => {
  const data = spotDataset();
  const result = validateMarkDataset(data, demoTerms, now(data));
  assert.equal(result.price, 2100000n);
  assert.equal(result.slots, 1);
  assert.equal(result.observedAt, periodStart - 2 * slot + 30);
  assert.equal(result.publishedAt, data.publishedAt);
  assert.equal(result.methodology, "pre-period-spot-v1");
  assert.equal(methodology(result.canonicalEvidence), "pre-period-spot-v1");
  assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
});

test("spot continues through the first slot, then the period-to-date mean takes over", () => {
  const first = spotDataset(periodStart + slot - 1);
  assert.equal(first.observations[0].slotStart, periodStart - slot);
  assert.equal(validateMarkDataset(first, demoTerms, now(first)).methodology, "pre-period-spot-v1");

  const mean = partialDataset(1, periodStart + slot);
  const result = validateMarkDataset(mean, demoTerms, mean.publishedAt);
  assert.equal(result.methodology, "equal-slot-mean-floor-v1");
  assert.equal(result.price, 2000000n);
  assert.equal(result.price, validatePartialDataset(mean, demoTerms, mean.publishedAt).price);
  assert.equal(validatePartialDataset(mean, demoTerms, mean.publishedAt).methodology, "equal-slot-mean-floor-v1");
});

test("after the period the mark dispatcher agrees with the settlement validator", () => {
  const at = demoDataset.publishedAt + 30;
  const mark = validateMarkDataset(structuredClone(demoDataset), demoTerms, at);
  const settlement = validateDataset(structuredClone(demoDataset), demoTerms, at);
  assert.equal(mark.canonicalEvidence, settlement.canonicalEvidence);
  assert.equal(mark.price, settlement.price);
});

test("spot data cannot be used as a period-to-date mean or as settlement data", () => {
  const data = spotDataset();
  assert.throws(() => validatePartialDataset(data, demoTerms, now(data)), /publication/);
  assert.throws(() => validateDataset(data, demoTerms, now(data)), /future|completed/);
  const late = spotDataset();
  late.publishedAt = periodStart + slot;
  assert.throws(() => validateMarkDataset(late, demoTerms, late.publishedAt), /range/);
});

for (const [name, change, pattern] of [
  ["an older slot than the latest completed", (d: ReturnType<typeof spotDataset>) => { d.observations[0].slotStart -= slot; d.observations[0].observedAt -= slot; }, /range/],
  ["the slot still in progress", (d: ReturnType<typeof spotDataset>) => { d.observations[0].slotStart += slot; d.observations[0].observedAt += slot; }, /range/],
  ["a second observation", (d: ReturnType<typeof spotDataset>) => d.observations.push({ ...d.observations[0] }), /complete/],
  ["no observation", (d: ReturnType<typeof spotDataset>) => d.observations.pop(), /complete/],
  ["an off-grid slot", (d: ReturnType<typeof spotDataset>) => { d.observations[0].slotStart += 1; }, /grid|range/],
  ["an observation outside its slot", (d: ReturnType<typeof spotDataset>) => { d.observations[0].observedAt = d.observations[0].slotStart - 1; }, /observation/],
  ["an observation after publication", (d: ReturnType<typeof spotDataset>) => { d.observations[0].observedAt = d.publishedAt + 1; }, /observation/],
  ["a mismatched source", (d: ReturnType<typeof spotDataset>) => { Object.assign(d, { sourceId: "other" }); }, /binding/],
  ["mismatched hardware", (d: ReturnType<typeof spotDataset>) => { d.hardware.model = "H100"; }, /hardware|binding/],
  ["a noncanonical price", (d: ReturnType<typeof spotDataset>) => { Object.assign(d.observations[0], { price: "01" }); }, /price/],
  ["an unbound field", (d: ReturnType<typeof spotDataset>) => { Object.assign(d, { provider: "unbound" }); }, /schema/],
] as const) {
  test(`spot rejects ${name}`, () => {
    const data = spotDataset();
    change(data);
    assert.throws(() => validateMarkDataset(data, demoTerms, now(data)), pattern);
  });
}

test("spot publication must be recent and not in the future; zero is a valid spot price", () => {
  const data = spotDataset();
  validateMarkDataset(data, demoTerms, data.publishedAt + demoTerms.maxPublicationAgeSeconds);
  assert.throws(() => validateMarkDataset(data, demoTerms, data.publishedAt + demoTerms.maxPublicationAgeSeconds + 1), /publication/);
  assert.throws(() => validateMarkDataset(data, demoTerms, data.publishedAt - 1), /publication/);
  const zero = spotDataset(periodStart - 600, "0");
  assert.equal(validateMarkDataset(zero, demoTerms, now(zero)).price, 0n);
});

test("spot observation times strictly increase across slots and into the mean", () => {
  const seen: number[] = [];
  for (let published = periodStart - 3 * slot + 60; published <= periodStart + 3 * slot + 60; published += slot) {
    const data = published < periodStart + slot ? spotDataset(published) : partialDataset(Math.floor((published - periodStart) / slot), published);
    seen.push(validateMarkDataset(data, demoTerms, published).observedAt);
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(new Set(seen).size, seen.length);
});

test("mark dispatcher rejects non-objects", () => {
  for (const data of [null, [], "x", 1]) assert.throws(() => validateMarkDataset(data, demoTerms, periodStart), /schema/);
});
