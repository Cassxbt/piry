import { Src } from "./Src";
import { DepthChart } from "./charts/lazy";
import type { KuruBook } from "../lib/kuru";
import { buildDepth } from "../lib/depth";
import { priceHuman, priceText, sizeHuman } from "../lib/kuruMath";
import { config } from "../config";

const LEVELS = 7;

export interface BookMark {
  price: number;
  label: string;
}

const fmtSize = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function OrderBook({ book, symbol, mark = null }: { book: KuruBook; symbol: string; mark?: BookMark | null }) {
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
  const mid = bestAsk !== null && bestBid !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null;
  const depth = buildDepth(
    bids.map((l) => ({ price: px(l.priceRaw), size: sz(l.sizeRaw) })),
    asks.map((l) => ({ price: px(l.priceRaw), size: sz(l.sizeRaw) })),
  );
  const tick = priceHuman(book.scale.tickSize, book.scale);
  const step = sizeHuman(1n, book.scale);
  const minOrder = Number(book.scale.minQuote) / 10 ** book.scale.quoteDecimals;

  return (
    <div className="book">
      <div className="book-top">
        <div>
          <p className="book-top-label">{mid !== null ? "Mid price" : "Book"}</p>
          <p className="book-top-value">{mid !== null ? mid.toFixed(4) : "One-sided"}</p>
        </div>
        <div className="book-top-meta">
          {spread !== null && mid !== null ? <span className="chart-badge chart-badge--flat">Spread {spread.toFixed(4)} ({((spread / mid) * 100).toFixed(1)}%)</span> : null}
          {mark && mid !== null ? (
            <span className="book-top-mark">
              {mark.label}, {Math.abs(mid - mark.price) / mark.price < 0.0005 ? "book mid at the mark" : `book mid ${mid > mark.price ? "above" : "below"} by ${Math.abs(((mid - mark.price) / mark.price) * 100).toFixed(1)}%`}
            </span>
          ) : null}
        </div>
      </div>

      {depth ? (
        <div className="book-depth">
          <DepthChart depth={depth} symbol={symbol} quote={config.kuru.quoteSymbol} mark={mark} height={190} />
          <ul className="chart-keys" aria-label="Depth chart key">
            <li><i style={{ background: "var(--chart-accent)" }} aria-hidden />Bids: size you can sell</li>
            <li><i style={{ background: "var(--chart-short)" }} aria-hidden />Asks: size you can buy</li>
          </ul>
        </div>
      ) : null}

      <div className="book-ladder" role="table" aria-label={`${symbol} order book`}>
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
          <span>{mid !== null ? `Mid ${mid.toFixed(4)}` : null}</span>
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
      </div>

      <div className="book-foot">
        <Src contract="Kuru OrderBook" address={book.market} block={book.block} />
        <p>
          Tick {tick.toString()}, size step {step.toString()}, minimum order {minOrder.toString()} {config.kuru.quoteSymbol}. Taker fee {(Number(book.fees.takerPps) / 1e5).toFixed(3)}%, maker fee {(Number(book.fees.makerPps) / 1e5).toFixed(3)}%.
        </p>
      </div>
    </div>
  );
}
