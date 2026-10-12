import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, parseAbiParameters } from "viem";
import { demoDataset, demoTerms } from "../demo.js";
import { indexIdentity, validateDataset } from "../validation.js";
import { encodeMarketReport } from "../report.js";

const destination = { market: "0x1111111111111111111111111111111111111111" as const, chainId: 10143n };
const result = () => validateDataset(demoDataset, demoTerms, demoDataset.publishedAt + 30);

test("report matches ComputeMarket.Report word order, widths and exactly 320 bytes", () => {
  const payload = encodeMarketReport(result(), demoTerms, destination);
  assert.equal((payload.length - 2) / 2, 320);
  const decoded = decodeAbiParameters(parseAbiParameters(
    "address,uint256,bytes32,bytes32,uint8,uint64,uint64,uint256,uint64,bytes32"), payload);
  const identity = indexIdentity(demoTerms);
  assert.deepEqual(decoded, [destination.market, destination.chainId, identity.indexId, identity.specHash,
    demoTerms.priceDecimals, BigInt(demoTerms.periodStart), BigInt(demoTerms.periodEnd),
    2333333n, BigInt(demoDataset.publishedAt), result().evidenceHash]);
});

test("reject zero, malformed destination, zero or oversized chain ID", () => {
  for (const market of ["0x00", `0x${"00".repeat(20)}`, "not-an-address"]) {
    assert.throws(() => encodeMarketReport(result(), demoTerms, { ...destination, market: market as `0x${string}` }));
  }
  for (const chainId of [0n, -1n, 1n << 256n]) {
    assert.throws(() => encodeMarketReport(result(), demoTerms, { ...destination, chainId }));
  }
});

test("report cannot relabel validated evidence or price", () => {
  const changedTerms = { ...demoTerms, periodEnd: demoTerms.periodEnd + 3600 };
  assert.throws(() => encodeMarketReport(result(), changedTerms, destination), /evidence|binding|period/);
  assert.throws(() => encodeMarketReport({ ...result(), price: 1n }, demoTerms, destination), /evidence|binding/);
  assert.throws(() => encodeMarketReport({ ...result(), evidenceHash: `0x${"aa".repeat(32)}` }, demoTerms, destination), /evidence|binding/);
});
