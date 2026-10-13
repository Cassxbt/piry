import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimExitOpen, classifyFreshness, useMarkFreshness } from "../hooks/markFreshness";

const m = vi.hoisted(() => ({ mark: undefined as unknown, now: 10_000n as bigint | null }));
vi.mock("../hooks/chain", () => ({
  useMarket: () => ({ data: {}, dataUpdatedAt: 0 }),
  useMark: () => ({ data: m.mark }),
  useChainNow: () => m.now,
}));

const at = (age: number, over: Partial<Parameters<typeof classifyFreshness>[0]> = {}) =>
  classifyFreshness({ updatedAt: 1_000n, isFinal: false, now: 1_000n + BigInt(age), staleSeconds: 1500, ...over });

describe("classifyFreshness", () => {
  it.each([
    [0, "fresh"],
    [1499, "fresh"],
    [1500, "fresh"],
    [1501, "stale"],
    [1800, "stale"],
    [1801, "stale"],
  ] as const)("a mark %i s old is %s against the 1500 s threshold", (age, state) => {
    expect(at(age).state).toBe(state);
    expect(at(age).ageSeconds).toBe(age);
  });

  it("is unknown, never fresh, when there is no update or no chain time", () => {
    expect(at(10, { updatedAt: null })).toEqual({ state: "unknown", ageSeconds: null });
    expect(at(10, { now: null })).toEqual({ state: "unknown", ageSeconds: null });
  });

  it("is final once the feed has the settled value, however old its timestamp", () => {
    expect(at(99_999, { isFinal: true }).state).toBe("final");
  });

  it("does not call a mark stale when no threshold is configured", () => {
    expect(at(99_999, { staleSeconds: 0 }).state).toBe("fresh");
  });

  it("opens claim deposits and withdrawals only for fresh and final marks", () => {
    expect(claimExitOpen(at(10))).toBe(true);
    expect(claimExitOpen(at(10, { isFinal: true }))).toBe(true);
    expect(claimExitOpen(at(2000))).toBe(false);
    expect(claimExitOpen(at(10, { updatedAt: null }))).toBe(false);
  });
});

describe("useMarkFreshness", () => {
  beforeEach(() => {
    m.now = 10_000n;
  });

  it("reads fresh and stale from the feed's updatedAt", () => {
    m.mark = { status: "ok", updatedAt: 9_000n, isFinal: false };
    expect(renderHook(() => useMarkFreshness()).result.current.state).toBe("fresh");
    m.mark = { status: "ok", updatedAt: 1_000n, isFinal: false };
    expect(renderHook(() => useMarkFreshness()).result.current.state).toBe("stale");
  });

  it.each([
    ["a read error", { status: "error", message: "rpc down" }],
    ["a feed with no update yet", { status: "empty" }],
    ["a read that has not returned", undefined],
  ])("is unknown for %s", (_name, mark) => {
    m.mark = mark;
    expect(renderHook(() => useMarkFreshness()).result.current.state).toBe("unknown");
  });

  it("is final for the settled feed", () => {
    m.mark = { status: "ok", updatedAt: 1_000n, isFinal: true };
    expect(renderHook(() => useMarkFreshness()).result.current.state).toBe("final");
  });
});
