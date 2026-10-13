import { useMemo } from "react";
import type { Address } from "viem";
import { config } from "../config";
import { exampleSize, quoteHedge, type Exposure, type PremiumQuote } from "../lib/hedge";
import { marketIssues, type KuruBook } from "../lib/kuru";
import { baseAtoms } from "../lib/kuruMath";
import { useKuruBook, type KuruSide } from "./kuru";

export interface HedgeQuote extends PremiumQuote {
  claims: bigint;
  block: bigint | null;
  bestAsk: number | null;
  bestSize: number | null;
  // Average ask over the claims the book fills now, fee excluded.
  avgAsk: number | null;
  // The book's own taker fee in percent (7000 pps is 0.07%).
  takerFeePct: number | null;
  // Claims (base units) resting on the visible asks.
  depth: bigint;
  // Why a listed book was not used; empty when it was used or none is listed.
  issues: string[];
}

// A book prices a hedge only if the contract itself says it trades this series' claim against the quote token.
export function usableBook(book: KuruBook | undefined, expected: { base: Address | null | undefined; quote: Address }): { book: KuruBook | null; issues: string[] } {
  if (!book) return { book: null, issues: [] };
  if (!expected.base) return { book: null, issues: ["There is no claim token for this series to check the book against."] };
  const issues = marketIssues(book, { base: expected.base, quote: expected.quote });
  return { book: issues.length === 0 ? book : null, issues };
}

const askDepth = (book: KuruBook) => book.asks.reduce((sum, l) => sum + baseAtoms(l.sizeRaw, book.scale), 0n);

function useSeriesBook(side: KuruSide, claimToken: Address | null | undefined) {
  const query = useKuruBook(side);
  // A failed refresh keeps the last data around; a stale book must not price anything.
  const data = query.isError ? undefined : query.data;
  return useMemo(() => usableBook(data, { base: claimToken, quote: config.kuru.quoteToken }), [data, claimToken]);
}

// One pricing rule for every page: the visible Kuru asks first, the feed mark for whatever the book cannot fill.
export function useHedgeQuote(
  claims: bigint | null,
  mark: { value: bigint; scale: bigint } | null,
  collateralDecimals: number,
  side: KuruSide = "long",
  claimToken?: Address | null,
): HedgeQuote | null {
  const { book, issues } = useSeriesBook(side, claimToken);
  const markValue = mark?.value;
  const markScale = mark?.scale;
  return useMemo(() => {
    if (claims === null) return null;
    const markInput = markValue !== undefined && markScale !== undefined ? { value: markValue, scale: markScale } : null;
    const quote = quoteHedge(claims, book ? { asks: book.asks, scale: book.scale, takerFeePps: book.fees.takerPps } : null, markInput, collateralDecimals);
    const best = book?.asks[0];
    const exFee = quote.executableCost - quote.fee;
    return {
      ...quote,
      claims,
      block: book?.block ?? null,
      bestAsk: best && book ? Number(best.priceRaw) / Number(book.scale.pricePrecision) : null,
      bestSize: best && book ? Number(best.sizeRaw) / Number(book.scale.sizePrecision) : null,
      avgAsk: book && quote.filled > 0n ? (Number(exFee) / 10 ** collateralDecimals) / (Number(quote.filled) / 10 ** book.scale.baseDecimals) : null,
      takerFeePct: book ? Number(book.fees.takerPps) / 1e5 : null,
      depth: book ? askDepth(book) : 0n,
      issues,
    };
  }, [claims, book, issues, markValue, markScale, collateralDecimals]);
}

// The example every page leads with: small enough that the book on this side can fill it in full right now.
export function useExampleSize(shape: Pick<Exposure, "band" | "priceDecimals" | "collateralDecimals"> | null, claimToken: Address | null | undefined, side: KuruSide = "long"): { gpus: bigint; hours: bigint } {
  const { book } = useSeriesBook(side, claimToken);
  return shape ? exampleSize(book ? askDepth(book) : 0n, shape) : { gpus: 8n, hours: 720n };
}

export function hedgeBasisNote(q: HedgeQuote, claimDecimals: number): string {
  const whole = (v: bigint) => (Number(v) / 10 ** claimDecimals).toLocaleString("en-US", { maximumFractionDigits: 2 });
  switch (q.basis) {
    case "book":
      return `The visible Kuru asks fill all ${whole(q.claims)} claims now, taker fee included.`;
    case "book+mark":
      return `The book can fill ${whole(q.filled)} of ${whole(q.claims)} claims now. The other ${whole(q.remainder)} are priced at the feed mark for illustration; nobody has offered them at that price.`;
    case "book-partial":
      return `The book can fill ${whole(q.filled)} of ${whole(q.claims)} claims now and no mark is available, so the figure covers only what is listed.`;
    case "mark":
      return q.issues.length > 0
        ? "The listed Kuru book is not this series' market, so it is not used. The whole hedge is priced at the feed mark, for illustration only."
        : "No asks are listed, so the whole hedge is priced at the feed mark, for illustration only.";
  }
}
