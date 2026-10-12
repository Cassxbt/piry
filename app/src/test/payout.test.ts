import { describe, expect, it } from "vitest";
import { bandPosition, payouts, previewRedeem, roundingLoss } from "../lib/payout";

const U256 = (1n << 256n) - 1n;
const band = { lower: 100n, upper: 300n };

describe("payouts (PayoutMath.t.sol vectors)", () => {
  it("pays only the short leg below the floor", () => {
    expect(payouts(1_000_000n, 99n, band)).toEqual({ long: 0n, short: 1_000_000n });
  });

  it("is exact at the floor and at the cap", () => {
    expect(payouts(1_000_000n, 100n, band)).toEqual({ long: 0n, short: 1_000_000n });
    expect(payouts(1_000_000n, 300n, band)).toEqual({ long: 1_000_000n, short: 0n });
  });

  it("splits evenly at the midpoint and pays only long above the cap", () => {
    expect(payouts(1_000_000n, 200n, band)).toEqual({ long: 500_000n, short: 500_000n });
    expect(payouts(1_000_000n, U256, band)).toEqual({ long: 1_000_000n, short: 0n });
  });

  it("rounds each leg down", () => {
    expect(payouts(2n, 1n, { lower: 0n, upper: 3n })).toEqual({ long: 0n, short: 1n });
  });

  it("keeps full precision for uint256 quantities", () => {
    const { long, short } = payouts(U256, 2n, { lower: 0n, upper: 3n });
    expect(long).toBe((U256 / 3n) * 2n);
    expect(short).toBe(U256 / 3n);
  });

  it("handles zero quantity and maximal narrow bounds", () => {
    expect(payouts(0n, 11n, { lower: 10n, upper: 12n })).toEqual({ long: 0n, short: 0n });
    expect(payouts(9n, U256 - 1n, { lower: U256 - 1n, upper: U256 })).toEqual({ long: 0n, short: 9n });
    expect(payouts(9n, U256, { lower: U256 - 1n, upper: U256 })).toEqual({ long: 9n, short: 0n });
  });

  it("translates with the band", () => {
    expect(payouts(1_000_000n, 175n, band)).toEqual({ long: 375_000n, short: 625_000n });
  });

  it("rejects empty or reversed bounds", () => {
    expect(() => payouts(1n, 1n, { lower: 1n, upper: 1n })).toThrow(RangeError);
    expect(() => payouts(1n, 1n, { lower: 2n, upper: 1n })).toThrow(RangeError);
  });

  it("conserves collateral within one unit and is monotonic (deterministic fuzz)", () => {
    let seed = 0x9e3779b97f4a7c15n;
    const next = (bits: number) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) & ((1n << BigInt(bits)) - 1n);
    };
    for (let i = 0; i < 2000; i++) {
      const q = next(52) * next(30);
      const lower = next(40);
      const upper = lower + next(40) + 1n;
      const price = next(41);
      const a = payouts(q, price, { lower, upper });
      expect(a.long + a.short).toBeLessThanOrEqual(q);
      expect(q - (a.long + a.short)).toBeLessThanOrEqual(1n);
      const b = payouts(q, price + 1n, { lower, upper });
      expect(b.long).toBeGreaterThanOrEqual(a.long);
      expect(b.short).toBeLessThanOrEqual(a.short);
    }
  });

  it("never lets splitting increase the payout", () => {
    const x = 7_777_777n;
    const y = 3_141_593n;
    const price = 2_333_333n;
    const b = { lower: 1_000_000n, upper: 4_000_000n };
    const joint = payouts(x + y, price, b);
    const split = [payouts(x, price, b), payouts(y, price, b)];
    expect(split[0]!.long + split[1]!.long).toBeLessThanOrEqual(joint.long);
    expect(split[0]!.short + split[1]!.short).toBeLessThanOrEqual(joint.short);
  });
});

describe("previewRedeem", () => {
  it("prices each leg on its own amount", () => {
    const b = { lower: 1_000_000n, upper: 4_000_000n };
    expect(previewRedeem(3_000_000n, 3_000_000n, 2_333_333n, b)).toBe(3_000_000n);
    expect(previewRedeem(1_000_000n, 0n, 3_500_000n, b)).toBe(833_333n);
    expect(previewRedeem(0n, 1_000_000n, 3_500_000n, b)).toBe(166_666n);
  });

  it("reproduces the README illustration: 1,000 units at $2-$4 settling at $3.50", () => {
    const b = { lower: 2_000_000n, upper: 4_000_000n };
    expect(payouts(1_000n, 3_500_000n, b)).toEqual({ long: 750n, short: 250n });
  });
});

describe("bandPosition", () => {
  it("clamps to the band", () => {
    expect(bandPosition(0n, band)).toBe(0);
    expect(bandPosition(400n, band)).toBe(1);
    expect(bandPosition(200n, band)).toBe(0.5);
  });
});

describe("roundingLoss", () => {
  const b = { lower: 0n, upper: 3n };

  it("equals the exact value minus the floored payout, leg by leg", () => {
    const { numerator, width } = roundingLoss(2n, 2n, 1n, b);
    const exact = (2n * 1n + 2n * 2n) * 10n ** 6n / width;
    const paid = (previewRedeem(2n, 2n, 1n, b)) * 10n ** 6n;
    expect(exact - paid).toBe((numerator * 10n ** 6n) / width);
  });

  it("is zero when a leg sits at or beyond a bound", () => {
    expect(roundingLoss(7n, 5n, 0n, b).numerator).toBe(0n);
    expect(roundingLoss(7n, 5n, 3n, b).numerator).toBe(0n);
  });
});
