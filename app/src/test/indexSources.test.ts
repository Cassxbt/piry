import { describe, expect, it } from "vitest";
import type { IndexComponent } from "../config/types";
import { medianOfValid, summarizeSources } from "../lib/indexSources";

const c = (status: IndexComponent["status"]): IndexComponent => ({ name: "s", detail: null, value: status === "valid" ? "2.50" : null, status, url: null, rule: null, why: null });

describe("summarizeSources", () => {
  it("reports no verdict while any source is still pending", () => {
    expect(summarizeSources([c("valid"), c("valid"), c("pending"), c("pending")], 3)).toEqual({ total: 4, valid: 2, failed: 0, pending: 2, quorum: null });
  });

  it("meets the rule with 3 of 4 valid and one recorded failure", () => {
    expect(summarizeSources([c("valid"), c("valid"), c("valid"), c("failed")], 3)).toMatchObject({ valid: 3, failed: 1, quorum: true });
  });

  it("misses the rule with 2 of 4 valid", () => {
    expect(summarizeSources([c("valid"), c("valid"), c("failed"), c("failed")], 3).quorum).toBe(false);
  });

  it("has no rule to judge against when none is configured", () => {
    expect(summarizeSources([c("valid")], null).quorum).toBeNull();
  });
});

describe("medianOfValid", () => {
  const v = (value: string, status: IndexComponent["status"] = "valid"): IndexComponent => ({ name: value, detail: null, value, status, url: null, rule: null, why: null });

  it("takes the mean of the two middle values for an even count (the live series deployment values)", () => {
    expect(medianOfValid([v("2.73"), v("2.69"), v("4.047"), v("4.17")], 6)).toBe(3_388_500n);
  });

  it("takes the middle value for an odd count and ignores failed sources", () => {
    expect(medianOfValid([v("2.73"), v("2.69"), v("4.17"), v("9.99", "failed")], 6)).toBe(2_730_000n);
  });

  it("returns null when no source is valid", () => {
    expect(medianOfValid([v("1.00", "pending")], 6)).toBeNull();
  });

  it("rounds an odd sum of the middle pair down", () => {
    expect(medianOfValid([v("0.000001"), v("0.000002")], 6)).toBe(1n);
  });
});
