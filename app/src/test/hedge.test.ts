import { describe, expect, it } from "vitest";
import {
  breakEvenIndex, claimsToHold, exampleSize, lockedMonthlyBill, lockedOwnerIncome, maxPayout, mintAndSellNet, monthlyBill, outcomeAt,
  otherSide, ownerOutcomeAt, premiumCost, quoteHedge, regimeOf,
} from "../lib/hedge";

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
  const free = 0n;

  it("prices the unfilled remainder at the feed mark and keeps it apart from the executable part", () => {
    const asks = [{ priceRaw: 6_000n, sizeRaw: 10_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale, takerFeePps: free }, mark, 6);
    expect(q.basis).toBe("book+mark");
    expect(q.filled).toBe(usd(10_000));
    expect(q.executableCost).toBe(usd(10_000 * 0.6));
    expect(q.remainder).toBe(usd(90_000));
    expect(q.remainderCost).toBe(usd(90_000 * 0.5));
    expect(q.premium).toBe(usd(10_000 * 0.6 + 90_000 * 0.5));
  });

  it("uses the book alone when it fills the full size", () => {
    const asks = [{ priceRaw: 4_000n, sizeRaw: 200_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale, takerFeePps: free }, mark, 6);
    expect(q).toEqual({ premium: usd(40_000), filled: claims, executableCost: usd(40_000), fee: 0n, remainder: 0n, remainderCost: 0n, basis: "book" });
  });

  it("falls back to the mark for an empty book and flags a partial book without a mark", () => {
    expect(quoteHedge(claims, null, mark, 6)).toMatchObject({ premium: usd(50_000), filled: 0n, executableCost: 0n, remainder: claims, basis: "mark" });
    const asks = [{ priceRaw: 6_000n, sizeRaw: 10_000n * 1_000_000n }];
    const q = quoteHedge(claims, { asks, scale, takerFeePps: free }, null, 6);
    expect(q.basis).toBe("book-partial");
    expect(q.premium).toBe(usd(6_000));
    expect(q.remainderCost).toBe(0n);
  });

  it("matches the pure-mark figure when the book is empty (Home and How it works agree with the calculator)", () => {
    expect(quoteHedge(claims, { asks: [], scale, takerFeePps: free }, mark, 6).premium).toBe((claims * mark.value) / mark.scale);
  });

  it("adds the taker fee to the executable premium (0.07% at takerPps 7000)", () => {
    const lots = { ...scale, sizePrecision: 1n };
    const asks = [{ priceRaw: 5_000n, sizeRaw: 100n }];
    const q = quoteHedge(100_000_000n, { asks, scale: lots, takerFeePps: 7_000n }, null, 6);
    expect(q.executableCost).toBe(50_035_000n);
    expect(q.fee).toBe(35_000n);
    expect(q.premium).toBe(50_035_000n);
  });

  it("never reports coverage beyond the lots it walked", () => {
    const lots = { ...scale, sizePrecision: 1n };
    const asks = [{ priceRaw: 5_000n, sizeRaw: 100n }];
    const fractional = quoteHedge(1_500_000n, { asks, scale: lots, takerFeePps: free }, { value: 50_000_000n, scale: 100_000_000n }, 6);
    expect(fractional).toMatchObject({ filled: 1_000_000n, executableCost: 500_000n, remainder: 500_000n, remainderCost: 250_000n, basis: "book+mark" });
    const subLot = quoteHedge(500_000n, { asks, scale: lots, takerFeePps: free }, null, 6);
    expect(subLot).toMatchObject({ filled: 0n, executableCost: 0n, remainder: 500_000n, basis: "book-partial" });
  });
});

describe("exampleSize", () => {
  const shape = { band: { lower: usd(2.5), upper: usd(4.5) }, priceDecimals: 6, collateralDecimals: 6 };

  it("sizes a small example from the claims the book offers, in round hours", () => {
    expect(exampleSize(usd(7_675), shape)).toEqual({ gpus: 8n, hours: 470n });
  });

  it("keeps the preferred example when the book is deep enough", () => {
    expect(exampleSize(usd(1_000_000), shape)).toEqual({ gpus: 8n, hours: 720n });
  });

  it("falls back to one GPU, then to one hour, when the book is thin", () => {
    expect(exampleSize(usd(100), shape)).toEqual({ gpus: 1n, hours: 50n });
    expect(exampleSize(usd(1), shape)).toEqual({ gpus: 1n, hours: 1n });
  });

  it("returns the preferred size when there is no depth to size from", () => {
    expect(exampleSize(0n, shape)).toEqual({ gpus: 8n, hours: 720n });
  });
});

describe("claims-position economics", () => {
  const band = { lower: usd(2.5), upper: usd(4.5) };

  it("mint, sell the long, keep the short: staying below the cap is not profit", () => {
    expect(mintAndSellNet({ quantity: usd(1), sold: "long", proceeds: 454_250n, price: usd(4.49), band })).toBe(-540_750n);
    expect(mintAndSellNet({ quantity: usd(1), sold: "long", proceeds: 454_250n, price: usd(2.5), band })).toBe(454_250n);
    expect(mintAndSellNet({ quantity: usd(1), sold: "short", proceeds: 545_750n, price: usd(4.5), band })).toBe(545_750n);
  });

  it("breaks even at L + c(U - L) for a long bought, and so for the long sold", () => {
    expect(breakEvenIndex("long", 0.45425, { lower: 2.5, upper: 4.5 })).toBeCloseTo(3.4085, 6);
    expect(breakEvenIndex("short", 0.54575, { lower: 2.5, upper: 4.5 })).toBeCloseTo(3.4085, 6);
    const at = usd(3.4085);
    expect(mintAndSellNet({ quantity: usd(1), sold: "long", proceeds: 454_250n, price: at, band })).toBe(0n);
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

describe("otherSide", () => {
  const band = { lower: usd(2.5), upper: usd(4.5) };

  it("reports the net result at a settlement price, the extremes and the break-even for selling the long", () => {
    const row = otherSide("long", 0.45425, band, 6, 6, 4.49);
    expect(row.net).toBeCloseTo(-0.54075, 6);
    expect(row.maxGain).toBeCloseTo(0.45425, 6);
    expect(row.maxLoss).toBeCloseTo(0.54575, 6);
    expect(row.breakEven).toBeCloseTo(3.4085, 6);
    expect(row.wins).toBe("below");
  });

  it("mirrors it for selling the short: it wins when the index settles high", () => {
    const row = otherSide("short", 0.54575, band, 6, 6, 4.5);
    expect(row.net).toBeCloseTo(0.54575, 6);
    expect(row.breakEven).toBeCloseTo(3.4085, 6);
    expect(row.wins).toBe("above");
  });
});
