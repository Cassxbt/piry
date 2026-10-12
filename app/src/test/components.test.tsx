import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BandRuler } from "../components/BandRuler";
import { OrderBook } from "../components/OrderBook";
import type { KuruBook } from "../lib/kuru";
import { rateLimitedFetch } from "../lib/rateLimit";

const scale = { pricePrecision: 1_000_000n, sizePrecision: 1_000_000n, tickSize: 1n, minQuote: 1n, maxQuote: 2n, baseDecimals: 6, quoteDecimals: 6 };
const book: KuruBook = {
  market: "0x3333333333333333333333333333333333333333",
  block: 123n,
  scale,
  fees: { takerPps: 0n, makerPps: 0n },
  baseToken: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  state: 0,
  asks: [
    { priceRaw: 520_000n, sizeRaw: 10_000_000n },
    { priceRaw: 530_000n, sizeRaw: 20_000_000n },
  ],
  bids: [{ priceRaw: 500_000n, sizeRaw: 5_000_000n }],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("OrderBook", () => {
  it("lists asks high to low above the spread and bids below it, with cumulative totals", () => {
    render(<OrderBook book={book} symbol="PIRY-L" />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual(["0.5300", "0.5200", "0.5000"]);
    expect(within(rows[0]!).getAllByRole("cell")[2]?.textContent).toBe("30.00");
    expect(screen.getByText(/Spread 0\.0200/)).toBeTruthy();
  });

  it("says so when a side is empty instead of inventing liquidity", () => {
    render(<OrderBook book={{ ...book, bids: [] }} symbol="PIRY-L" />);
    expect(screen.getByText("No bids resting on the book.")).toBeTruthy();
    expect(screen.getByText(/one side is empty/)).toBeTruthy();
  });

  it("cites its source contract and block", () => {
    render(<OrderBook book={book} symbol="PIRY-L" />);
    expect(screen.getByText(/Kuru OrderBook/)).toBeTruthy();
    expect(screen.getByText(/block 123/)).toBeTruthy();
  });
});

describe("BandRuler", () => {
  it("labels the floor, the cap and any marker, and describes itself for screen readers", () => {
    render(
      <BandRuler lower={2} upper={4} markers={[{ value: 2.66, label: "settled $2.66", tone: "long" }]} money={(v) => `$${v}`} ariaLabel="Payout band $2 to $4" />,
    );
    expect(screen.getByRole("img", { name: "Payout band $2 to $4" })).toBeTruthy();
    expect(screen.getByText("FLOOR $2")).toBeTruthy();
    expect(screen.getByText("CAP $4")).toBeTruthy();
    expect(screen.getByText("settled $2.66")).toBeTruthy();
  });
});

describe("rateLimitedFetch", () => {
  it("spaces calls by their JSON-RPC count so a batch cannot exceed the provider limit", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const base = (async () => { starts.push(Date.now()); return new Response("{}"); }) as typeof fetch;
    const limited = rateLimitedFetch(10, base);
    const batch = JSON.stringify(Array.from({ length: 5 }, (_, id) => ({ id })));
    const first = limited("http://rpc", { method: "POST", body: batch });
    const second = limited("http://rpc", { method: "POST", body: JSON.stringify({ id: 1 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await Promise.all([first, second]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
  });
});
