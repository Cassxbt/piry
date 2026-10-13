import { describe, expect, it } from "vitest";
import { claimsToHold, lockedMonthlyBill, maxPayout, monthlyBill, outcomeAt, lockedOwnerIncome, ownerOutcomeAt, premiumCost, quoteHedge, regimeOf } from "../lib/hedge";

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

describe("quoteHedge", () => {
  const scale = { pricePrecision: 10_000n, sizePrecision: 1_000_000n, tickSize: 1n, minQuote: 0n, maxQuote: 10n ** 30n, baseDecimals: 6, quoteDecimals: 6 };
  const mark = { value: 50_000_000n, scale: 100_000_000n };
  const claims = usd(100_000);

  it("prices the unfilled remainder at the feed mark instead of ignoring it", () => {
    const asks = [{ priceRaw: 6_000n, sizeRaw: 10_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale }, mark, 6);
    expect(q.basis).toBe("book+mark");
    expect(q.filled).toBe(usd(10_000));
    expect(q.premium).toBe(usd(10_000 * 0.6 + 90_000 * 0.5));
    expect(q.premium).toBeGreaterThan(usd(10_000 * 0.6));
  });

  it("uses the book alone when it fills the full size", () => {
    const asks = [{ priceRaw: 4_000n, sizeRaw: 200_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale }, mark, 6);
    expect(q).toEqual({ premium: usd(40_000), filled: claims, basis: "book" });
  });

  it("falls back to the mark for an empty book and flags a partial book without a mark", () => {
    expect(quoteHedge(claims, null, mark, 6)).toEqual({ premium: usd(50_000), filled: 0n, basis: "mark" });
    const asks = [{ priceRaw: 6_000n, sizeRaw: 10_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale }, null, 6);
    expect(q.basis).toBe("book-partial");
    expect(q.premium).toBe(usd(6_000));
  });

  it("matches the pure-mark figure when the book is empty (Home and How it works agree with the calculator)", () => {
    expect(quoteHedge(claims, { asks: [], scale }, mark, 6).premium).toBe((claims * mark.value) / mark.scale);
  });
});

describe("ownerOutcomeAt (lender side)", () => {
  const claims = claimsToHold(exposure);

  it("holds income flat at the cap inside the band, whichever way the index moves", () => {
    for (const p of [2, 2.5, 3, 3.7, 4]) {
      expect(ownerOutcomeAt(exposure, claims, 0n, usd(p)).hedged).toBe(lockedOwnerIncome(exposure));
    }
    expect(lockedOwnerIncome(exposure)).toBe(usd(288_000));
  });

  it("stops protecting below the floor: income keeps falling with the market", () => {
    const atFloor = ownerOutcomeAt(exposure, claims, 0n, usd(2));
    const below = ownerOutcomeAt(exposure, claims, 0n, usd(1));
    expect(below.payout).toBe(atFloor.payout);
    expect(atFloor.hedged - below.hedged).toBe(atFloor.unhedged - below.unhedged);
  });

  it("pays nothing above the cap, so the owner keeps the upside less the premium", () => {
    const o = ownerOutcomeAt(exposure, claims, usd(1_000), usd(6));
    expect(o.payout).toBe(0n);
    expect(o.hedged).toBe(o.unhedged - usd(1_000));
  });
});
