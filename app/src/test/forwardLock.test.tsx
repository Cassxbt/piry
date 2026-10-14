import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ForwardLock } from "../components/live/ForwardLock";

afterEach(cleanup);

const exposure = { gpus: 1n, hours: 100n, band: { lower: 2_500_000n, upper: 4_500_000n }, priceDecimals: 6, collateralDecimals: 6 };
const text = (node: ReturnType<typeof render>) => node.container.textContent ?? "";

describe("ForwardLock", () => {
  it("shows the level the hedge actually holds and how far it is from today's bill", () => {
    const t = text(render(<ForwardLock exposure={exposure} claims={200_000_000n} premium={110_000_000n} today={3} />));
    expect(t).toContain("$360");
    expect(t).toContain("$300");
    expect(t).toMatch(/\$60\.00 above today/);
    expect(t).not.toMatch(/equals today/i);
  });

  it("reports a lock below today's bill when the premium is small", () => {
    const t = text(render(<ForwardLock exposure={exposure} claims={200_000_000n} premium={10_000_000n} today={3} />));
    expect(t).toContain("$260");
    expect(t).toMatch(/\$40\.00 below today/);
  });

  it("does the same for income on the owner side: cap x GPU-hours less the premium", () => {
    const t = text(render(<ForwardLock exposure={exposure} claims={200_000_000n} premium={110_000_000n} today={3} side="owner" />));
    expect(t).toContain("$340");
    expect(t).toContain("$300");
    expect(t).toMatch(/\$40\.00 above today/);
    expect(t).not.toMatch(/equals today/i);
  });
});
