import { describe, expect, it } from "vitest";
import { BaseError } from "viem";
import { describeError } from "../hooks/action";

describe("describeError", () => {
  it("maps Kuru's InvalidWithdrawalPrice selector, wherever it appears in the cause chain", () => {
    const inner = new Error("execution reverted, data: 0x393843a9");
    const outer = new BaseError("The contract function reverted", { cause: inner });
    expect(describeError(outer)).toMatch(/needs a fresh mark \(under 30 min\)/);
    expect(describeError(new Error("revert 0x393843A9"))).toMatch(/keeper refreshes it every few minutes/);
  });

  it("leaves other errors alone", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});
