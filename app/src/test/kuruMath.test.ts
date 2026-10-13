import { describe, expect, it } from "vitest";
import { baseAtoms, checkLimitOrder, planSwap, precisionDecimals, quoteNotional, sizeFromBaseAtoms, slippageFloor, toPriceRaw, toSizeRaw } from "../lib/kuruMath";

// MON/USDC from the testnet deployment page: price precision 1e6, size precision 1e6, tick 1, min 10 USDC.
const mon = {
  pricePrecision: 1_000_000n,
  sizePrecision: 1_000_000n,
  tickSize: 1n,
  minQuote: 10_000_000n,
  maxQuote: 5_000_000_000_000n,
  baseDecimals: 18,
  quoteDecimals: 6,
};
// WETH/USDC: price precision 100, size precision 1e10.
const weth = { ...mon, pricePrecision: 100n, sizePrecision: 10_000_000_000n, baseDecimals: 18 };

describe("Kuru unit conversion (deployment page examples)", () => {
  it("encodes a 0.025 USDC MON price as 25000", () => {
    expect(toPriceRaw("0.025", mon)).toBe(25_000n);
  });

  it("encodes 1 MON as 1,000,000 size units, and 1 WETH as 10,000,000,000", () => {
    expect(toSizeRaw("1", mon)).toBe(1_000_000n);
    expect(toSizeRaw("1", weth)).toBe(10_000_000_000n);
  });

  it("encodes a 3,000 USDC WETH price as 300000", () => {
    expect(toPriceRaw("3000", weth)).toBe(300_000n);
  });

  it("converts size units to raw base atoms and back", () => {
    expect(baseAtoms(1_000_000n, mon)).toBe(10n ** 18n);
    expect(sizeFromBaseAtoms(10n ** 18n, mon)).toBe(1_000_000n);
  });

  it("rejects more precision than the market supports", () => {
    expect(toPriceRaw("0.0000001", mon)).toBeNull();
    expect(toPriceRaw("abc", mon)).toBeNull();
    expect(toPriceRaw("", mon)).toBeNull();
  });

  it("accepts a trailing decimal point and a leading one", () => {
    expect(toSizeRaw("2.", mon)).toBe(2_000_000n);
    expect(toSizeRaw(".5", mon)).toBe(500_000n);
  });

  it("rejects non power-of-ten precisions", () => {
    expect(() => precisionDecimals(250n)).toThrow();
  });
});

describe("quoteNotional and checkLimitOrder", () => {
  it("prices 400 claims at 0.5 as 200 USDC atoms", () => {
    expect(quoteNotional(toPriceRaw("0.5", mon)!, toSizeRaw("400", mon)!, mon)).toBe(200_000_000n);
  });

  it("flags orders below the minimum notional", () => {
    expect(checkLimitOrder(500_000n, toSizeRaw("1", mon), mon)).toMatch(/minimum notional/);
  });

  it("flags off-tick prices", () => {
    expect(checkLimitOrder(500_001n, toSizeRaw("100", mon), { ...mon, tickSize: 10n })).toMatch(/tick/);
  });

  it("accepts a valid order", () => {
    expect(checkLimitOrder(500_000n, toSizeRaw("100", mon), mon)).toBeNull();
  });

  it("asks for missing input", () => {
    expect(checkLimitOrder(null, 1n, mon)).toMatch(/price/);
    expect(checkLimitOrder(1n, null, mon)).toMatch(/quantity/);
  });
});

describe("slippageFloor", () => {
  it("applies basis points", () => {
    expect(slippageFloor(1_000_000n, 50)).toBe(995_000n);
  });
});

import { priceText, walkAsks } from "../lib/kuruMath";

describe("walkAsks", () => {
  const asks = [
    { priceRaw: 400_000n, sizeRaw: 100_000_000n },
    { priceRaw: 500_000n, sizeRaw: 100_000_000n },
  ];

  it("fills within the best level at its price", () => {
    expect(walkAsks(asks, 50_000_000n, mon)).toEqual({ cost: 20_000_000n, filledSize: 50_000_000n, complete: true });
  });

  it("walks to the next level when the best is exhausted", () => {
    expect(walkAsks(asks, 150_000_000n, mon)).toEqual({ cost: 40_000_000n + 25_000_000n, filledSize: 150_000_000n, complete: true });
  });

  it("reports incomplete fills instead of inventing liquidity", () => {
    expect(walkAsks(asks, 500_000_000n, mon)).toEqual({ cost: 40_000_000n + 50_000_000n, filledSize: 200_000_000n, complete: false });
  });

  it("rounds up for the buyer", () => {
    expect(walkAsks([{ priceRaw: 1n, sizeRaw: 10n }], 1n, mon).cost).toBe(1n);
  });
});

describe("priceText", () => {
  it("keeps adjacent ticks distinguishable", () => {
    expect(priceText(25_901n, mon)).toBe("0.025901");
    expect(priceText(25_900n, mon)).toBe("0.0259");
    expect(priceText(100_000_000n, mon)).toBe("100.0000");
  });

  it("uses the market precision for coarse markets", () => {
    expect(priceText(300_000n, weth)).toBe("3000.00");
  });
});

describe("planSwap", () => {
  it("caps the input to what the quote actually used and bases the floor on that amount", () => {
    const plan = planSwap({ amountInUsed: 10_000_000n, amountOut: 20_000_000n }, 100_000_000n, 50);
    expect(plan).toEqual({ amountIn: 10_000_000n, minAmountOut: 19_900_000n, partial: true });
  });

  it("sends the whole input when the book can take all of it", () => {
    const plan = planSwap({ amountInUsed: 100_000_000n, amountOut: 200_000_000n }, 100_000_000n, 100);
    expect(plan).toEqual({ amountIn: 100_000_000n, minAmountOut: 198_000_000n, partial: false });
  });

  it("handles the sell direction the same way: only the claims the book can absorb are sent", () => {
    const plan = planSwap({ amountInUsed: 30_000_000n, amountOut: 15_000_000n }, 100_000_000n, 50);
    expect(plan).toEqual({ amountIn: 30_000_000n, minAmountOut: 14_925_000n, partial: true });
  });

  it("refuses a quote that uses nothing, returns nothing or rounds its floor to zero", () => {
    expect(planSwap({ amountInUsed: 0n, amountOut: 5n }, 100n, 50)).toBeNull();
    expect(planSwap({ amountInUsed: 10n, amountOut: 0n }, 100n, 50)).toBeNull();
    expect(planSwap({ amountInUsed: 10n, amountOut: 1n }, 100n, 50)).toBeNull();
  });
});
