import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceTable } from "../components/SourceTable";
import type { IndexComponent } from "../config/types";
import { whyNow } from "../content/whyNow";

afterEach(cleanup);

describe("whyNow", () => {
  it("cites every fact with at least one https link", () => {
    for (const item of whyNow) {
      expect(item.sources.length).toBeGreaterThan(0);
      for (const source of item.sources) expect(source.url).toMatch(/^https:\/\//);
    }
  });

  it("never states a claim as a one-for-one hedge or an unsourced volatility figure", () => {
    const text = whyNow.map((i) => i.text).join(" ");
    expect(text).not.toMatch(/85%/);
    expect(text).not.toMatch(/offset N/i);
  });
});

describe("SourceTable", () => {
  const components: IndexComponent[] = [
    { name: "Akash on-chain marketplace", detail: "Public chain data", value: "2.56", status: "valid", url: null, rule: null, why: null },
    { name: "RunPod", detail: null, value: "2.99", status: "valid", url: "https://example.com/runpod", rule: null, why: null },
    { name: "Verda", detail: null, value: null, status: "failed", url: null, rule: null, why: null },
    { name: "Shadeform", detail: "Median across 13 clouds", value: "3.10", status: "valid", url: null, rule: null, why: null },
  ];

  it("renders one row per configured source with its value and status", () => {
    render(<SourceTable components={components} minValid={3} asOf="12 Oct 2026" />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("$2.56")).toBeTruthy();
    expect(within(rows[2]!).getByText("n/a")).toBeTruthy();
    expect(within(rows[2]!).getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "RunPod" }).getAttribute("href")).toBe("https://example.com/runpod");
  });

  it("states the rule and how the recorded sources stand against it", () => {
    render(<SourceTable components={components} minValid={3} asOf="12 Oct 2026" />);
    expect(screen.getByText(/at least 3 of 4 are valid/)).toBeTruthy();
    expect(screen.getByText(/3 valid, 1 failed, so the rule is met/)).toBeTruthy();
  });

  it("says nothing is recorded yet instead of showing placeholder prices", () => {
    const pending = components.map((c) => ({ ...c, value: null, status: "pending" as const }));
    render(<SourceTable components={pending} minValid={3} asOf={null} />);
    expect(screen.getByText(/No readings are recorded for this series yet/)).toBeTruthy();
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it("renders nothing for a series without components", () => {
    const { container } = render(<SourceTable components={[]} minValid={null} asOf={null} />);
    expect(container.firstChild).toBeNull();
  });
});
