import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { hedgeBasisNote, usableBook, type HedgeQuote } from "../hooks/hedgeQuote";
import type { KuruBook } from "../lib/kuru";

const claim = "0x1111111111111111111111111111111111111111" as Address;
const otherClaim = "0x9999999999999999999999999999999999999999" as Address;
const quote = "0x2222222222222222222222222222222222222222" as Address;
const scale = { pricePrecision: 1_000_000n, sizePrecision: 1n, tickSize: 100n, minQuote: 1_000_000n, maxQuote: 10n ** 12n, baseDecimals: 6, quoteDecimals: 6 };
const book: KuruBook = {
  market: "0x3333333333333333333333333333333333333333", block: 1n, scale, fees: { takerPps: 7000n, makerPps: 4000n },
  baseToken: claim, quoteToken: quote, state: 0, asks: [{ priceRaw: 500_000n, sizeRaw: 100n }], bids: [],
};

describe("usableBook", () => {
  it("accepts a book whose base and quote tokens are the series' claim and the quote token", () => {
    expect(usableBook(book, { base: claim, quote }).book).toBe(book);
  });

  it("refuses another series' book, such as the live book beside the fast demo", () => {
    const result = usableBook(book, { base: otherClaim, quote });
    expect(result.book).toBeNull();
    expect(result.issues.join(" ")).toMatch(/base token/);
  });

  it("refuses a wrong quote token or an inactive market, and a book with nothing to check it against", () => {
    expect(usableBook(book, { base: claim, quote: otherClaim }).book).toBeNull();
    expect(usableBook({ ...book, state: 1 }, { base: claim, quote }).book).toBeNull();
    expect(usableBook(book, { base: undefined, quote }).book).toBeNull();
    expect(usableBook(undefined, { base: claim, quote })).toEqual({ book: null, issues: [] });
  });
});

describe("hedgeBasisNote", () => {
  const base: HedgeQuote = {
    premium: 0n, filled: 0n, executableCost: 0n, fee: 0n, remainder: 0n, remainderCost: 0n, basis: "book",
    claims: 100_000_000n, block: 1n, bestAsk: 0.5, bestSize: 100, avgAsk: 0.5, takerFeePct: 0.07, depth: 0n, issues: [],
  };

  it("says the book fills the size only when it does", () => {
    expect(hedgeBasisNote({ ...base, filled: 100_000_000n }, 6)).toMatch(/fill all 100 claims now/);
  });

  it("separates what the book fills now from the illustrative remainder", () => {
    const note = hedgeBasisNote({ ...base, basis: "book+mark", filled: 40_000_000n, remainder: 60_000_000n }, 6);
    expect(note).toMatch(/fill 40 of 100 claims now/);
    expect(note).toMatch(/other 60 .* feed mark for illustration/);
    expect(note).toMatch(/nobody has offered/i);
  });

  it("does not call a sub-lot remainder filled", () => {
    expect(hedgeBasisNote({ ...base, basis: "book+mark", claims: 1_500_000n, filled: 1_000_000n, remainder: 500_000n }, 6)).toMatch(/fill 1 of 1\.5 claims/);
  });

  it("explains a refused book", () => {
    expect(hedgeBasisNote({ ...base, basis: "mark", issues: ["Its base token is 0x99, not the Piry claim."] }, 6)).toMatch(/not this series/i);
  });
});
