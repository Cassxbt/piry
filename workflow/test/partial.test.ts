import assert from "node:assert/strict";
import { test } from "node:test";
import { demoDataset, demoTerms } from "../demo.js";
import { validateDataset, validatePartialDataset } from "../validation.js";
import { partialDataset } from "./fixtures.js";

const slot = demoTerms.slotSeconds;
const copy = (completed = 2) => partialDataset(completed);
const now = (data: { publishedAt: number }) => data.publishedAt + 30;

test("period-to-date mean covers exactly the completed slots, rounded down", () => {
  const data = copy();
  const result = validatePartialDataset(data, demoTerms, now(data));
  assert.equal(result.price, 2500000n);
  assert.equal(result.slots, 2);
  assert.equal(result.observedAt, demoTerms.periodStart + slot + 30);
  assert.equal(result.publishedAt, data.publishedAt);
  assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
  data.observations[0].price = "2000001";
  assert.equal(validatePartialDataset(data, demoTerms, now(data)).price, 2500000n);
});

test("a single completed slot is its own mean; boundaries are inclusive", () => {
  const data = copy(1);
  assert.equal(validatePartialDataset(data, demoTerms, now(data)).price, 2000000n);
  const exact = copy(1);
  exact.publishedAt = demoTerms.periodStart + slot;
  assert.equal(validatePartialDataset(exact, demoTerms, exact.publishedAt).slots, 1);
  exact.publishedAt -= 1;
  assert.throws(() => validatePartialDataset(exact, demoTerms, exact.publishedAt + 1), /publication/);
});

test("order does not affect period-to-date evidence", () => {
  const data = copy();
  const reversed = copy();
  reversed.observations.reverse();
  assert.deepEqual(validatePartialDataset(reversed, demoTerms, now(data)), validatePartialDataset(data, demoTerms, now(data)));
});

test("after the period ends the partial validator agrees with the settlement validator", () => {
  const at = demoDataset.publishedAt + 30;
  const partial = validatePartialDataset(structuredClone(demoDataset), demoTerms, at);
  const settlement = validateDataset(structuredClone(demoDataset), demoTerms, at);
  assert.equal(partial.slots, 3);
  assert.equal(partial.observedAt, demoDataset.observations[2].observedAt);
  assert.equal(partial.price, settlement.price);
  assert.equal(partial.evidenceHash, settlement.evidenceHash);
  assert.equal(partial.canonicalEvidence, settlement.canonicalEvidence);
});

test("settlement validation still refuses period-to-date data", () => {
  const data = copy();
  assert.throws(() => validateDataset(data, demoTerms, now(data)), /future|completed/);
  const late = copy();
  late.publishedAt = demoTerms.periodEnd + 60;
  assert.throws(() => validateDataset(late, demoTerms, now(late)), /complete/);
  assert.throws(() => validatePartialDataset(late, demoTerms, now(late)), /complete/);
});

for (const [name, change, pattern] of [
  ["missing latest completed slot", (d: ReturnType<typeof copy>) => d.observations.pop(), /complete/],
  ["in-progress slot included", (d: ReturnType<typeof copy>) => d.observations.push({ ...demoDataset.observations[2] }), /complete/],
  ["gap before the latest slot", (d: ReturnType<typeof copy>) => { d.observations[1] = { ...demoDataset.observations[2] }; }, /range/],
  ["duplicate", (d: ReturnType<typeof copy>) => { d.observations[1] = { ...d.observations[0] }; }, /duplicate/],
  ["off grid", (d: ReturnType<typeof copy>) => { d.observations[0].slotStart += 1; }, /grid/],
  ["before period", (d: ReturnType<typeof copy>) => { d.observations[0].slotStart -= slot; }, /range/],
  ["observation outside its slot", (d: ReturnType<typeof copy>) => { d.observations[1].observedAt = d.observations[0].observedAt; }, /observation/],
  ["mismatched source", (d: ReturnType<typeof copy>) => { Object.assign(d, { sourceId: "other" }); }, /binding/],
  ["mismatched hardware", (d: ReturnType<typeof copy>) => { d.hardware.model = "H100"; }, /hardware|binding/],
  ["mismatched period", (d: ReturnType<typeof copy>) => { d.periodEnd += slot; }, /binding/],
  ["noncanonical price", (d: ReturnType<typeof copy>) => { Object.assign(d.observations[0], { price: "01" }); }, /price/],
  ["unbound field", (d: ReturnType<typeof copy>) => { Object.assign(d, { provider: "unbound" }); }, /schema/],
] as const) {
  test(`period-to-date rejects ${name}`, () => {
    const data = copy();
    change(data);
    assert.throws(() => validatePartialDataset(data, demoTerms, now(data)), pattern);
  });
}

test("publication must be recent, not in the future, and cover a completed slot", () => {
  const data = copy();
  validatePartialDataset(data, demoTerms, data.publishedAt + demoTerms.maxPublicationAgeSeconds);
  assert.throws(() => validatePartialDataset(data, demoTerms, data.publishedAt + demoTerms.maxPublicationAgeSeconds + 1), /publication/);
  assert.throws(() => validatePartialDataset(data, demoTerms, data.publishedAt - 1), /publication/);
  const before = copy(0);
  before.publishedAt = demoTerms.periodStart + slot - 1;
  assert.throws(() => validatePartialDataset(before, demoTerms, now(before)), /publication/);
  const early = copy(0);
  early.publishedAt = demoTerms.periodStart - 1;
  assert.throws(() => validatePartialDataset(early, demoTerms, now(early)), /publication/);
});
