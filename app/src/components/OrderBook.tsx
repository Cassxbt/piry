import { Src } from "./Src";
import type { KuruBook } from "../lib/kuru";
import { priceHuman, priceText, sizeHuman } from "../lib/kuruMath";
import { config } from "../config";

const LEVELS = 7;

export function OrderBook({ book, symbol }: { book: KuruBook; symbol: string }) {
  const asks = book.asks.slice(0, LEVELS);
  const bids = book.bids.slice(0, LEVELS);
  const px = (raw: bigint) => priceHuman(raw, book.scale);
  const sz = (raw: bigint) => sizeHuman(raw, book.scale);

  const cumulate = (levels: typeof asks) => {
    let total = 0;
    return levels.map((l) => {
      total += sz(l.sizeRaw);
      return { ...l, total };
    });
  };
  const askRows = cumulate(asks);
  const bidRows = cumulate(bids);
  const max = Math.max(askRows.at(-1)?.total ?? 0, bidRows.at(-1)?.total ?? 0, 1e-9);
  const bestAsk = asks[0] ? px(asks[0].priceRaw) : null;
  const bestBid = bids[0] ? px(bids[0].priceRaw) : null;
  const spread = bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null;

  const fmtSize = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

  return (
    <div className="book" role="table" aria-label={`${symbol} order book`}>
      <div className="book-head" role="row">
        <span role="columnheader">Price ({config.kuru.quoteSymbol})</span>
        <span className="r" role="columnheader">Size ({symbol})</span>
        <span className="r" role="columnheader">Total</span>
      </div>
      {askRows.length === 0 ? <div className="book-empty">No asks resting on the book.</div> : null}
      {[...askRows].reverse().map((l) => (
        <div className="book-row ask" role="row" key={`a${l.priceRaw}`}>
          <i className="depth" style={{ width: `${(l.total / max) * 100}%` }} />
          <span className="px" role="cell">{priceText(l.priceRaw, book.scale)}</span>
          <span className="r" role="cell">{fmtSize(sz(l.sizeRaw))}</span>
          <span className="r" role="cell">{fmtSize(l.total)}</span>
        </div>
      ))}
      <div className="book-mid">
        <span>{spread !== null ? `Spread ${spread.toFixed(4)}` : "No spread: one side is empty"}</span>
        <span>{bestBid !== null && bestAsk !== null ? `Mid ${((bestBid + bestAsk) / 2).toFixed(4)}` : null}</span>
      </div>
      {bidRows.map((l) => (
        <div className="book-row bid" role="row" key={`b${l.priceRaw}`}>
          <i className="depth" style={{ width: `${(l.total / max) * 100}%` }} />
          <span className="px" role="cell">{priceText(l.priceRaw, book.scale)}</span>
          <span className="r" role="cell">{fmtSize(sz(l.sizeRaw))}</span>
          <span className="r" role="cell">{fmtSize(l.total)}</span>
        </div>
      ))}
      {bidRows.length === 0 ? <div className="book-empty">No bids resting on the book.</div> : null}
      <div style={{ padding: "12px 20px 16px" }}>
        <Src contract="Kuru OrderBook" address={book.market} block={book.block} />
      </div>
    </div>
  );
}
