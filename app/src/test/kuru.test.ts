import { describe, expect, it } from "vitest";
import { marketIssues, type KuruBook } from "../lib/kuru";

const claim = "0x1111111111111111111111111111111111111111" as const;
const usdc = "0x2222222222222222222222222222222222222222" as const;
const book = (over: Partial<KuruBook>): KuruBook => ({
  market: "0x3333333333333333333333333333333333333333",
  block: 1n,
  scale: { pricePrecision: 1_000_000n, sizePrecision: 1_000_000n, tickSize: 1n, minQuote: 1n, maxQuote: 2n, baseDecimals: 6, quoteDecimals: 6 },
  fees: { takerPps: 0n, makerPps: 0n },
  baseToken: claim,
  quoteToken: usdc,
  state: 0,
  bids: [],
  asks: [],
  ...over,
});

describe("marketIssues", () => {
  it("accepts a market whose own base and quote tokens match", () => {
    expect(marketIssues(book({}), { base: claim, quote: usdc })).toEqual([]);
  });

  it("compares addresses case-insensitively", () => {
    expect(marketIssues(book({ baseToken: claim.toUpperCase().replace("0X", "0x") as `0x${string}` }), { base: claim, quote: usdc })).toEqual([]);
  });

  it("flags a different base token, a different quote token and an inactive market", () => {
    const issues = marketIssues(
      book({ baseToken: "0x4444444444444444444444444444444444444444", quoteToken: "0x5555555555555555555555555555555555555555", state: 2 }),
      { base: claim, quote: usdc },
    );
    expect(issues).toHaveLength(3);
  });
});
