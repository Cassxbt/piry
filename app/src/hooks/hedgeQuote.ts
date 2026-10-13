import { useMemo } from "react";
import { quoteHedge, type PremiumQuote } from "../lib/hedge";
import { useKuruBook, type KuruSide } from "./kuru";

export interface HedgeQuote extends PremiumQuote {
  claims: bigint;
  block: bigint | null;
  bestAsk: number | null;
  bestSize: number | null;
}

// One pricing rule for every page: the visible Kuru asks first, the feed mark for whatever the book cannot fill.
export function useHedgeQuote(claims: bigint | null, mark: { value: bigint; scale: bigint } | null, collateralDecimals: number, side: KuruSide = "long"): HedgeQuote | null {
  const book = useKuruBook(side).data;
  const markValue = mark?.value;
  const markScale = mark?.scale;
  return useMemo(() => {
    if (claims === null) return null;
    const markInput = markValue !== undefined && markScale !== undefined ? { value: markValue, scale: markScale } : null;
    const quote = quoteHedge(claims, book ?? null, markInput, collateralDecimals);
    const best = book?.asks[0];
    return {
      ...quote,
      claims,
      block: book?.block ?? null,
      bestAsk: best && book ? Number(best.priceRaw) / Number(book.scale.pricePrecision) : null,
      bestSize: best && book ? Number(best.sizeRaw) / Number(book.scale.sizePrecision) : null,
    };
  }, [claims, book, markValue, markScale, collateralDecimals]);
}

export function hedgeBasisNote(q: HedgeQuote, claimDecimals: number): string {
  const whole = (v: bigint) => (Number(v) / 10 ** claimDecimals).toLocaleString("en-US", { maximumFractionDigits: 0 });
  switch (q.basis) {
    case "book":
      return "The visible Kuru asks fill the full size.";
    case "book+mark":
      return `The book fills ${whole(q.filled)} of ${whole(q.claims)} claims; the remainder is priced at the feed mark.`;
    case "book-partial":
      return `The book fills ${whole(q.filled)} of ${whole(q.claims)} claims and no mark is available, so the figure covers only what is listed.`;
    case "mark":
      return "No asks are listed, so the whole hedge is priced at the feed mark.";
  }
}
