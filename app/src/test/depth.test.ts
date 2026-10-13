import { describe, expect, it } from "vitest";
import { buildDepth } from "../lib/depth";

describe("buildDepth", () => {
  const bids = [{ price: 0.44, size: 100 }, { price: 0.43, size: 200 }];
  const asks = [{ price: 0.46, size: 50 }, { price: 0.47, size: 50 }];

  it("accumulates away from the spread on each side", () => {
    const depth = buildDepth(bids, asks);
    const at = (p: number) => depth?.points.find((x) => x.price === p);
    expect(at(0.44)?.bid).toBe(100);
    expect(at(0.43)?.bid).toBe(300);
    expect(at(0.46)?.ask).toBe(50);
    expect(at(0.47)?.ask).toBe(100);
  });

  it("values cumulative size at each level's own price", () => {
    const depth = buildDepth(bids, asks);
    expect(depth?.points.find((x) => x.price === 0.43)?.bidCost).toBeCloseTo(44 + 86, 9);
    expect(depth?.points.find((x) => x.price === 0.47)?.askCost).toBeCloseTo(23 + 23.5, 9);
  });

  it("orders points by price and pads the window on both sides", () => {
    const depth = buildDepth(bids, asks);
    const prices = depth?.points.map((p) => p.price) ?? [];
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    expect(depth?.xMin).toBeLessThan(0.43);
    expect(depth?.xMax).toBeGreaterThan(0.47);
    expect(depth?.maxSize).toBe(300);
  });

  it("holds the deepest bid flat to the left edge and the deepest ask to the right edge", () => {
    const depth = buildDepth(bids, asks);
    expect(depth?.points[0]).toMatchObject({ bid: 300 });
    expect(depth?.points.at(-1)).toMatchObject({ ask: 100 });
  });

  it("handles one-sided and empty books", () => {
    expect(buildDepth([], [])).toBeNull();
    expect(buildDepth(bids, [])?.points.every((p) => p.ask === null)).toBe(true);
  });
});
