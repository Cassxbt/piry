import { describe, expect, it } from "vitest";
import { claimsToHold, lockedMonthlyBill, maxPayout, monthlyBill, outcomeAt, premiumCost, regimeOf } from "../lib/hedge";

const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const exposure = {
  gpus: 100n,
  hours: 720n,
  band: { lower: usd(2), upper: usd(4) },
  priceDecimals: 6,
  collateralDecimals: 6,
};

describe("claimsToHold", () => {
  it("sizes the hedge as gpus x hours x band width", () => {
    expect(claimsToHold(exposure)).toBe(usd(144_000));
    expect(maxPayout(claimsToHold(exposure))).toBe(usd(144_000));
  });

  it("handles differing price and collateral decimals", () => {
    const e = { ...exposure, band: { lower: 2_00000000n, upper: 4_00000000n }, priceDecimals: 8 };
    expect(claimsToHold(e)).toBe(usd(144_000));
  });

  it("floors fractional claim base units", () => {
    const e = { ...exposure, gpus: 1n, hours: 1n, band: { lower: 1n, upper: 2n }, priceDecimals: 9, collateralDecimals: 6 };
    expect(claimsToHold(e)).toBe(0n);
  });
});

describe("outcomeAt", () => {
  const claims = claimsToHold(exposure);

  it("offsets the bill above the floor exactly while inside the band", () => {
    const o = outcomeAt(exposure, claims, 0n, usd(3));
    expect(o.unhedged).toBe(usd(216_000));
    expect(o.payout).toBe(usd(72_000));
    expect(o.hedged).toBe(lockedMonthlyBill(exposure));
    expect(o.hedged).toBe(usd(144_000));
  });

  it("pays nothing below the floor, so the hedge costs only the premium", () => {
    const premium = usd(50_000);
    const o = outcomeAt(exposure, claims, premium, usd(1));
    expect(o.payout).toBe(0n);
    expect(o.hedged).toBe(monthlyBill(exposure, usd(1)) + premium);
  });

  it("stops paying at the cap: the extra bill above U is unhedged", () => {
    const atCap = outcomeAt(exposure, claims, 0n, usd(4));
    const above = outcomeAt(exposure, claims, 0n, usd(6));
    expect(atCap.payout).toBe(maxPayout(claims));
    expect(above.payout).toBe(maxPayout(claims));
    expect(above.hedged - atCap.hedged).toBe(above.unhedged - atCap.unhedged);
    expect(above.hedged).toBe(usd(6 * 72_000 - 144_000));
  });

  it("never lets the hedge pay more than the cap", () => {
    for (const p of [0, 1, 2, 2.5, 3, 4, 5, 100]) {
      expect(outcomeAt(exposure, claims, 0n, usd(p)).payout).toBeLessThanOrEqual(maxPayout(claims));
    }
  });
});

describe("premiumCost", () => {
  it("prices claims at the ask and rounds up for the buyer", () => {
    expect(premiumCost(1_000_000n, 500_000n, 1_000_000n, 6, 6)).toBe(500_000n);
    expect(premiumCost(1n, 1n, 1_000_000n, 6, 6)).toBe(1n);
  });

  it("handles the Kuru price precision and differing decimals", () => {
    expect(premiumCost(10n ** 18n, 4100n, 10000n, 18, 6)).toBe(410_000n);
  });
});

describe("regimeOf", () => {
  it("labels below, in-band and above-cap prices", () => {
    expect(regimeOf(usd(1), exposure.band)).toBe("below");
    expect(regimeOf(usd(2), exposure.band)).toBe("in-band");
    expect(regimeOf(usd(4), exposure.band)).toBe("in-band");
    expect(regimeOf(usd(4.01), exposure.band)).toBe("above");
  });
});
