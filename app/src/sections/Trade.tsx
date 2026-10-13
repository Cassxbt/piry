import { useState } from "react";
import { OrderBook } from "../components/OrderBook";
import { Pending } from "../components/Pending";
import { Section } from "../components/Section";
import { FaucetCard } from "../components/FaucetCard";
import { useQuoteBalance } from "../hooks/faucet";
import { useViewer } from "../hooks/viewer";
import { config, primarySubject } from "../config";
import { useChainNow, useMark, useMarket, useSeriesShortMark } from "../hooks/chain";
import { kuruMarketFor, useKuruBook, type KuruSide } from "../hooks/kuru";
import { marketIssues } from "../lib/kuru";
import { KuruAccount } from "./trade/KuruAccount";
import { MintCard } from "./trade/Mint";
import { Ticket } from "./trade/Ticket";

type Route = "buy" | "mint";

const FLOW = [
  ["Fund", "Approve and deposit the quote token into your Kuru balance. Kuru trades from that balance, not from your wallet."],
  ["Order", "Buy at market with an exact-input swap and a minimum output, or rest a limit order at your price."],
  ["Check", "A confirmed transaction is not a resting order. Read the market outcome and your open order slots."],
  ["Cancel and withdraw", "Cancel what still rests, then withdraw the claims you bought so they sit in your wallet, ready to redeem."],
] as const;

function KuruPending() {
  return (
    <div className="stack">
      <Pending title="Kuru listing pending">
        Kuru is deploying the claim/{config.kuru.quoteSymbol} market for this series. The live order book, the order ticket and your trading balance switch on here as soon as the market is listed. Nothing is simulated in the meantime.
        <span className="sub" style={{ display: "block", marginTop: 6 }}>Enabled by setting <span className="mono">kuru.longMarket</span> in <span className="mono">src/config/{config.network}.json</span>.</span>
      </Pending>
      <div className="panel">
        <div className="panel-head"><span className="label">How a trade will run</span></div>
        <ol className="steps panel-pad">
          {FLOW.map(([title, text], i) => (
            <li key={title}>
              <span className="n">0{i + 1}</span>
              <div>
                <h4>{title}</h4>
                <p className="sub">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function Trade() {
  const viewer = useViewer();
  const noUsdc = useQuoteBalance(viewer.connected ? viewer.address : undefined).data === 0n && config.faucet !== undefined;
  const market = useMarket();
  const snapshot = market.data;
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const settled = snapshot?.state.settled === true;
  const ended = snapshot !== undefined && !settled && (now ?? snapshot.block.timestamp) >= snapshot.terms.periodEnd;
  const [route, setRoute] = useState<Route>("buy");
  const [side, setSide] = useState<KuruSide>(config.kuru.longMarket === null && config.kuru.shortMarket !== null ? "short" : "long");

  const longBook = useKuruBook("long");
  const shortBook = useKuruBook("short");
  const book = side === "long" ? longBook : shortBook;
  const listed = kuruMarketFor(side) !== null;
  const bothListed = config.kuru.longMarket !== null && config.kuru.shortMarket !== null;
  const claimAddress = snapshot ? (side === "long" ? snapshot.claims.long : snapshot.claims.short) : null;
  const issues = book.data && claimAddress ? marketIssues(book.data, { base: claimAddress, quote: config.kuru.quoteToken }) : [];
  const preview = import.meta.env.VITE_KURU_LONG_MARKET !== undefined || import.meta.env.VITE_KURU_SHORT_MARKET !== undefined;
  const symbol = snapshot ? (side === "long" ? snapshot.claims.longSymbol : snapshot.claims.shortSymbol) : side === "long" ? "PIRY-L" : "PIRY-S";
  const longMark = useMark().data;
  const shortMark = useSeriesShortMark(primarySubject).data;
  const feedMark = side === "long" ? longMark : shortMark;
  const bookMark = feedMark?.status === "ok" ? { price: Number(feedMark.answer) / 10 ** feedMark.decimals, label: `Feed mark ${(Number(feedMark.answer) / 10 ** feedMark.decimals).toFixed(4)}` } : null;

  return (
    <Section
      id="trade"
      index="3/6"
      kicker="Trade"
      title={
        <>
          Buy the long on Kuru, or <em>mint a pair</em> and take the other side
        </>
      }
      lede="Hedgers buy long claims from Kuru's on-chain order book. Anyone willing to carry the risk mints a pair and sells a leg into it. The book below is read directly from Kuru's OrderBook contract."
    >
      <div className="route" role="group" aria-label="Choose a route">
        <button type="button" aria-pressed={route === "buy"} onClick={() => { setRoute("buy"); setSide("long"); }}>
          <span className="t">Hedge: buy LONG</span>
          <span className="d">You rent GPUs. Buy long claims that pay when the index rises.</span>
        </button>
        <button type="button" aria-pressed={route === "mint"} onClick={() => setRoute("mint")}>
          <span className="t">Take the short: mint and sell</span>
          <span className="d">
            Mint a pair, sell {bothListed ? "the short or long leg" : "the long leg"} to the book and keep the other. You are paid the sale price now; your net result depends on where the index settles, and the calculator shows the break-even.
          </span>
        </button>
      </div>

      {!snapshot ? (
        <Pending title="No market deployed on this network yet">
          The order book, tickets and balances need a deployed ComputeMarket. They activate when <span className="mono">deployments/{config.network}.json</span> lists a completed deployment.
        </Pending>
      ) : (
        <div className="stack-lg">
          {bothListed ? (
            <div className="segmented" role="group" aria-label="Market">
              <button type="button" aria-pressed={side === "long"} onClick={() => setSide("long")}>{snapshot.claims.longSymbol}/{config.kuru.quoteSymbol}</button>
              <button type="button" aria-pressed={side === "short"} onClick={() => setSide("short")}>{snapshot.claims.shortSymbol}/{config.kuru.quoteSymbol}</button>
            </div>
          ) : null}

          {noUsdc ? <FaucetCard /> : null}

          <div className="trade">
            <div className="panel">
              <div className="panel-head">
                <span className="label">{symbol} / {config.kuru.quoteSymbol} order book</span>
                {listed ? <span className="chip ok">Listed</span> : <span className="chip plain">Pending</span>}
              </div>
              {!listed ? (
                <div className="panel-pad"><KuruPending /></div>
              ) : book.isLoading ? (
                <div className="panel-pad"><p className="sub">Reading the book</p></div>
              ) : book.isError || !book.data ? (
                <div className="panel-pad">
                  <Pending title="Could not read the Kuru market">
                    {book.error instanceof Error ? book.error.message : "The configured address did not answer like a Kuru OrderBook."}
                  </Pending>
                </div>
              ) : (
                <OrderBook book={book.data} symbol={symbol} mark={bookMark} />
              )}
            </div>

            <div className="stack">
              {route === "mint" ? <MintCard snapshot={snapshot} /> : null}
              {listed && book.data ? (
                <div className="panel">
                  <div className="panel-head"><span className="label">{route === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}</span></div>
                  <div className="panel-pad stack">
                    {issues.length > 0 ? (
                      <div className="callout bad" role="alert">
                        <strong>{preview ? "Preview market, not the Piry listing." : "This is not the market it should be, so trading is disabled."}</strong> {issues.join(" ")}
                      </div>
                    ) : null}
                    {settled ? (
                      <div className="callout bad" role="alert">
                        <strong>Settled, trading closed: redeem instead.</strong> The index price is fixed, so resting orders no longer price a live risk. Withdraw your claims from Kuru and <a href="#redeem">redeem them for collateral</a>.
                      </div>
                    ) : ended ? (
                      <div className="callout warn" role="status">
                        <strong>The period has ended and settlement is pending.</strong> A trade now is a bet on the report that is about to fix the price. Minting is closed.
                      </div>
                    ) : null}
                    <fieldset disabled={settled} className="ticket-fieldset">
                    <Ticket key={`${side}-${route}`} snapshot={snapshot} book={book.data} side={side} defaultBuy={route === "buy"} blocked={(issues.length > 0 && !preview) || settled} />
                    </fieldset>
                  </div>
                </div>
              ) : route === "buy" ? (
                <div className="panel">
                  <div className="panel-head"><span className="label">Buy {symbol}</span></div>
                  <div className="panel-pad">
                    <p className="sub">
                      The order ticket appears when the Kuru market is listed. To hold long claims today, mint a pair directly from the contract using the other route.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {listed ? <KuruAccount snapshot={snapshot} /> : null}
        </div>
      )}
    </Section>
  );
}
