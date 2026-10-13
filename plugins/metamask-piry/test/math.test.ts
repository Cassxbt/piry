import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsForGpuHours, parseDecimal, parsePositive, parseSlippageBps, payouts, previewRedeem, slippageFloor, valueAtMark } from "../src/math.js";
import { PiryError } from "../src/errors.js";

const band = { lower: 2_500_000n, upper: 4_500_000n, priceDecimals: 6 };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PiryError).code; } return null; };

test("claims = GPU-hours x band width", () => {
  assert.equal(claimsForGpuHours(500_000_000n, band, 6), 1_000_000_000n); // 500 h -> 1000 claims
  assert.equal(claimsForGpuHours(1_500_000n, band, 6), 3_000_000n); // 1.5 h -> 3 claims
});

test("claims floor and never over-hedge", () => {
  const odd = { lower: 2_500_001n, upper: 4_500_000n, priceDecimals: 6 };
  assert.equal(claimsForGpuHours(1n, odd, 6), 1n); // 1 micro-hour x 1.999999 USD = 1.999999 micro -> 1
  assert.equal(claimsForGpuHours(0n, band, 6), 0n);
});

test("payouts match PayoutMath: clamped, each leg floored", () => {
  assert.deepEqual(payouts(1000n, 2_000_000n, band), { long: 0n, short: 1000n });
  assert.deepEqual(payouts(1000n, 2_500_000n, band), { long: 0n, short: 1000n });
  assert.deepEqual(payouts(1000n, 4_500_000n, band), { long: 1000n, short: 0n });
  assert.deepEqual(payouts(1000n, 9_000_000n, band), { long: 1000n, short: 0n });
  assert.deepEqual(payouts(1_000_000n, 3_500_000n, band), { long: 500_000n, short: 500_000n });
  // 3 x 1/3 style rounding: the two legs can sum to one unit less than the quantity
  const p = payouts(1n, 3_000_001n, band);
  assert.deepEqual(p, { long: 0n, short: 0n });
  assert.throws(() => payouts(1n, 1n, { ...band, lower: band.upper }), RangeError);
});

test("previewRedeem prices each leg on its own amount, like ComputeMarket", () => {
  assert.equal(previewRedeem(1_000_000n, 0n, 3_500_000n, band), 500_000n);
  assert.equal(previewRedeem(0n, 1_000_000n, 3_500_000n, band), 500_000n);
  assert.equal(previewRedeem(7n, 5n, 3_333_333n, band), (7n * 833_333n) / 2_000_000n + (5n * 1_166_667n) / 2_000_000n);
});

test("slippage floor rounds down and rejects values past the 10% cap", () => {
  assert.equal(slippageFloor(1_000_000n, 100), 990_000n);
  assert.equal(slippageFloor(999n, 100), 989n);
  assert.equal(parseSlippageBps("100"), 100);
  assert.equal(code(() => parseSlippageBps("1001")), "INVALID_SLIPPAGE");
  assert.equal(code(() => parseSlippageBps("1.5")), "INVALID_SLIPPAGE");
  assert.equal(code(() => parseSlippageBps("-1")), "INVALID_SLIPPAGE");
});

test("decimal parsing is strict", () => {
  assert.equal(parseDecimal("12.5", 6, "x"), 12_500_000n);
  assert.equal(parseDecimal("0.000001", 6, "x"), 1n);
  assert.equal(parsePositive("500", 6, "x"), 500_000_000n);
  for (const bad of ["", "-1", "1e3", "1,5", "0x10", " ", "1.", ".5", "1.1234567"]) assert.equal(code(() => parseDecimal(bad, 6, "x")), "INVALID_AMOUNT", bad);
  assert.equal(code(() => parsePositive("0", 6, "x")), "INVALID_AMOUNT");
});

test("mark value of claims", () => {
  assert.equal(valueAtMark(1_000_000_000n, 45_425_000n), 454_250_000n);
});
