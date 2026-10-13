import { describe, expect, it } from "vitest";
import { H100_WEEKLY_ON_DEMAND } from "../data/h100Weekly";
import { studyHedge } from "../lib/hedgeStudy";

const band = { lower: 2.5, upper: 4.5 };

describe("studyHedge", () => {
  it("removes all variance of the month average with an average-settled claim when the price stays inside the band", () => {
    const study = studyHedge([3, 3.2, 3.4, 3.1, 3.5, 3.3, 3.6, 3.2], band);
    expect(study?.varianceRemoved.average).toBeCloseTo(1, 9);
    expect(study?.varianceRemoved.snapshot).toBeLessThan(1);
    expect(study?.breaches).toEqual({ below: 0, above: 0 });
  });

  it("stops hedging above the cap and counts breaches", () => {
    const study = studyHedge([3, 4, 5, 6, 7, 5, 4, 3.9], band);
    expect(study?.breaches).toEqual({ below: 0, above: 4 });
    expect(study?.varianceRemoved.average).toBeLessThan(1);
  });

  it("summarises 4-week changes over rolling windows", () => {
    const study = studyHedge([2, 2, 2, 2, 4, 4, 4, 4, 4], { lower: 1, upper: 5 });
    expect(study?.change4w.windows).toBe(5);
    expect(study?.change4w.best).toBe(100);
    expect(study?.change4w.worst).toBe(0);
  });

  it("needs more than one month of data", () => {
    expect(studyHedge([3, 3, 3, 3, 3], band)).toBeNull();
  });

  it("runs on the vendored 53-week GetDeploying snapshot", () => {
    const study = studyHedge(H100_WEEKLY_ON_DEMAND.map((r) => r.median), band);
    expect(study?.weeks).toBe(53);
    expect(study?.latest).toBe(3.73);
    expect(study?.varianceRemoved.average).toBeGreaterThanOrEqual(study?.varianceRemoved.snapshot ?? 1);
  });
});
