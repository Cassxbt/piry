import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { demoTerms } from "../demo.js";
import { indexIdentity, validateMarkDataset, validatePartialDataset } from "../validation.js";
import { encodeMarkReport } from "../report.js";
import { partialDataset, spotDataset } from "./fixtures.js";

const destination = { feed: "0x3333333333333333333333333333333333333333" as const, chainId: 10143n };
const data = partialDataset(2);
const result = () => validatePartialDataset(data, demoTerms, data.publishedAt + 30);

test("mark report is exactly 192 bytes in feed, chain, index, price, observation time, evidence order", () => {
  const payload = encodeMarkReport(result(), demoTerms, destination);
  assert.equal((payload.length - 2) / 2, 192);
  const decoded = decodeAbiParameters(parseAbiParameters("address,uint256,bytes32,uint256,uint64,bytes32"), payload);
  assert.deepEqual(decoded, [destination.feed, destination.chainId, indexIdentity(demoTerms).indexId, 2500000n,
    BigInt(demoTerms.periodStart + demoTerms.slotSeconds + 30), keccak256(toBytes(result().canonicalEvidence))]);
});

test("reject zero, malformed destination, zero or oversized chain ID", () => {
  for (const feed of ["0x00", `0x${"00".repeat(20)}`, "not-an-address"]) {
    assert.throws(() => encodeMarkReport(result(), demoTerms, { ...destination, feed: feed as `0x${string}` }), /destination/);
  }
  for (const chainId of [0n, -1n, 1n << 256n]) {
    assert.throws(() => encodeMarkReport(result(), demoTerms, { ...destination, chainId }), /destination/);
  }
});

test("mark report cannot relabel validated evidence, price or observation time", () => {
  const changedTerms = { ...demoTerms, periodEnd: demoTerms.periodEnd + 3600 };
  assert.throws(() => encodeMarkReport(result(), changedTerms, destination), /evidence|binding|period/);
  assert.throws(() => encodeMarkReport({ ...result(), price: 1n }, demoTerms, destination), /evidence|binding/);
  assert.throws(() => encodeMarkReport({ ...result(), observedAt: result().observedAt + 1 }, demoTerms, destination), /evidence|binding/);
  assert.throws(() => encodeMarkReport({ ...result(), evidenceHash: `0x${"aa".repeat(32)}` }, demoTerms, destination), /evidence|binding/);
});

test("pre-period spot encodes to the same 192-byte layout", () => {
  const spot = spotDataset();
  const validated = validateMarkDataset(spot, demoTerms, spot.publishedAt + 30);
  const payload = encodeMarkReport(validated, demoTerms, destination);
  assert.equal((payload.length - 2) / 2, 192);
  const decoded = decodeAbiParameters(parseAbiParameters("address,uint256,bytes32,uint256,uint64,bytes32"), payload);
  assert.deepEqual(decoded, [destination.feed, destination.chainId, indexIdentity(demoTerms).indexId, 2100000n,
    BigInt(demoTerms.periodStart - 2 * demoTerms.slotSeconds + 30), keccak256(toBytes(validated.canonicalEvidence))]);
  const relabelled = { ...validated, canonicalEvidence: validated.canonicalEvidence.replace("pre-period-spot-v1", "equal-slot-mean-floor-v1") };
  assert.throws(() => encodeMarkReport(relabelled, demoTerms, destination), /evidence|binding/);
});

test("observation time is reported a clock-skew margin earlier, never before the epoch", () => {
  const observedAt = result().observedAt;
  const decode = (payload: `0x${string}`) =>
    decodeAbiParameters(parseAbiParameters("address,uint256,bytes32,uint256,uint64,bytes32"), payload)[4];
  assert.equal(decode(encodeMarkReport(result(), demoTerms, destination, 15)), BigInt(observedAt - 15));
  assert.equal(decode(encodeMarkReport(result(), demoTerms, destination, 0)), BigInt(observedAt));
  for (const margin of [-1, 1.5, Number.NaN, observedAt, observedAt + 1]) {
    assert.throws(() => encodeMarkReport(result(), demoTerms, destination, margin), /margin/);
  }
});
