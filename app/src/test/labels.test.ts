import { describe, expect, it } from "vitest";
import { MARK_CADENCE, settlementLabel } from "../lib/labels";

describe("settlementLabel", () => {
  it("does not call an unsettled market settled", () => {
    expect(settlementLabel({ settled: false, settledByFallback: false }, undefined)).toEqual({ title: "not settled", text: "has not settled" });
  });

  it("distinguishes a CRE report from the permissionless fallback", () => {
    const report = settlementLabel({ settled: true, settledByFallback: false }, "verified");
    const fallback = settlementLabel({ settled: true, settledByFallback: true }, "verified");
    expect(report.title).toBe("settled by CRE report");
    expect(fallback.title).toBe("settled by fallback");
    expect(fallback.text).toMatch(/fallback/);
    expect(fallback.text).not.toMatch(/settled by a CRE/);
    expect(fallback.text).not.toMatch(/re-derives/);
  });

  it("reports the evidence outcome rather than assuming it verified", () => {
    const text = (state: Parameters<typeof settlementLabel>[1]) => settlementLabel({ settled: true, settledByFallback: false }, state).text;
    expect(text("verified")).toMatch(/re-derives the price in your browser/);
    expect(text("failed")).toMatch(/failed verification/);
    expect(text("unverified")).toMatch(/cannot re-derive/);
    expect(text("unavailable")).toMatch(/not available/);
    expect(text(undefined)).toMatch(/not available/);
  });
});

describe("MARK_CADENCE", () => {
  it("states a target, not a guarantee", () => {
    expect(MARK_CADENCE).toMatch(/every 5 minutes/);
    expect(MARK_CADENCE).toMatch(/20 minutes/);
    expect(MARK_CADENCE).toMatch(/30 minutes/);
    expect(MARK_CADENCE).not.toMatch(/always|never/i);
  });
});
