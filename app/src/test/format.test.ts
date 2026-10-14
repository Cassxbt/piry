import { describe, expect, it } from "vitest";
import { usdRounded } from "../lib/format";

describe("usdRounded", () => {
  it("rounds to the cent instead of truncating", () => {
    expect(usdRounded(930_000n, 6)).toBe("$0.93");
    expect(usdRounded(18_539_999n, 6)).toBe("$18.54");
    expect(usdRounded(999_999n, 6)).toBe("$1.00");
    expect(usdRounded(4_000n, 6)).toBe("$0.00");
    expect(usdRounded(5_000n, 6)).toBe("$0.01");
  });

  it("keeps grouping and sign", () => {
    expect(usdRounded(1_234_567_890_000n, 6)).toBe("$1,234,567.89");
    expect(usdRounded(-2_505_000n, 6)).toBe("-$2.51");
  });
});
