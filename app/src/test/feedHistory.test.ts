import { describe, expect, it } from "vitest";
import { attachLogs, changeOver, shortOf, windowPoints, type FeedPoint } from "../lib/feedHistory";

const point = (round: number, t: number, index: number): FeedPoint => ({
  round: BigInt(round), t, index, long: 0, short: 0, evidenceHash: null, block: null, tx: null, final: false, held: false,
});

describe("shortOf (PiryShortFeed rule)", () => {
  it("is one minus the long answer", () => {
    expect(shortOf(44_425_000n)).toBe(55_575_000n);
    expect(shortOf(1n)).toBe(99_999_999n);
  });

  it("floors at one unit when the long is at the cap, so a price is never non-positive", () => {
    expect(shortOf(100_000_000n)).toBe(1n);
  });

  it("rejects an answer outside the feed's own range", () => {
    expect(() => shortOf(0n)).toThrow(RangeError);
    expect(() => shortOf(100_000_001n)).toThrow(RangeError);
  });
});

describe("windowPoints", () => {
  const all = [point(1, 1_000, 3.0), point(2, 2_000, 3.2), point(3, 5_000, 3.1)];

  it("shows everything for ALL and extends the last value to now as a held point", () => {
    const w = windowPoints(all, "ALL", 6_000);
    expect(w.points.map((p) => p.t)).toEqual([1_000, 2_000, 5_000, 6_000]);
    expect(w.points.at(-1)?.held).toBe(true);
    expect(w.points.at(-1)?.index).toBe(3.1);
  });

  it("never opens a window before the first round", () => {
    const w = windowPoints(all, "1D", 6_000);
    expect(w.start).toBe(1_000);
  });

  it("carries in the value in force when a short window opens", () => {
    const w = windowPoints(all, "1H", 9_000);
    expect(w.start).toBe(5_400);
    expect(w.points[0]).toMatchObject({ t: 5_400, index: 3.1, held: true });
  });

  it("does not add a held point when the last round is the latest instant", () => {
    const w = windowPoints(all, "ALL", 5_000);
    expect(w.points.at(-1)?.held).toBe(false);
  });

  it("handles an empty history", () => {
    expect(windowPoints([], "ALL", 100).points).toEqual([]);
  });
});

describe("changeOver", () => {
  it("reports direction, delta and percent", () => {
    expect(changeOver([3.0, 3.3])).toMatchObject({ direction: "up" });
    expect(changeOver([3.0, 3.3]).pct).toBeCloseTo(10, 6);
    expect(changeOver([3.0, 2.7]).direction).toBe("down");
  });

  it("is flat for unchanged or single values", () => {
    expect(changeOver([3.3885, 3.3885]).direction).toBe("flat");
    expect(changeOver([3.3885]).direction).toBe("flat");
  });
});

describe("attachLogs", () => {
  it("adds block and transaction to the rounds the event scan found", () => {
    const tx = `0x${"ab".repeat(32)}` as const;
    const out = attachLogs([point(1, 1, 1), point(2, 2, 2)], [{ round: 2n, block: 77n, tx }]);
    expect(out[0]?.tx).toBeNull();
    expect(out[1]).toMatchObject({ block: 77n, tx });
  });
});
