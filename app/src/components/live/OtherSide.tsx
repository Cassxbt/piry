import { config } from "../../config";
import { usableBook } from "../../hooks/hedgeQuote";
import { useKuruBook } from "../../hooks/kuru";
import { otherSide } from "../../lib/hedge";
import type { MarketSnapshot } from "../../lib/reads";

const dollars = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(4)}`;

// The counterparty to the hedger: mint a pair, sell one leg to the book, keep the other. Staying under the cap is not
// profit, so each strategy shows its own net result and break-even index at the current best bid.
export function OtherSide({ snapshot, scrub }: { snapshot: MarketSnapshot; scrub: number }) {
  const longBook = usableBook(useKuruBook("long").data, { base: snapshot.claims.long, quote: config.kuru.quoteToken }).book;
  const shortBook = usableBook(useKuruBook("short").data, { base: snapshot.claims.short, quote: config.kuru.quoteToken }).book;
  const band = { lower: snapshot.terms.lower, upper: snapshot.terms.upper };
  const pd = snapshot.terms.priceDecimals;
  const cd = snapshot.collateral.decimals;
  const bid = (b: typeof longBook) => {
    const top = b?.bids[0];
    return top && b ? Number(top.priceRaw) / Number(b.scale.pricePrecision) : null;
  };
  const rows = [
    { key: "long", title: `Sell ${snapshot.claims.longSymbol}, keep ${snapshot.claims.shortSymbol}`, bid: bid(longBook) },
    { key: "short", title: `Sell ${snapshot.claims.shortSymbol}, keep ${snapshot.claims.longSymbol}`, bid: bid(shortBook) },
  ] as const;

  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Taking the other side: mint a pair, sell one leg</span></div>
      <div className="panel-pad stack">
        <p className="sub">
          Minting a pair puts in $1 of collateral per pair. You are paid the sale price now and keep the other leg, so the result depends on where the index settles, not on whether it stays under the cap. Figures are per pair at the best bid, before fees and gas.
        </p>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr><th>Strategy</th><th className="r">Paid now</th><th className="r">Net at ${scrub.toFixed(2)}</th><th className="r">Best case</th><th className="r">Worst case</th><th className="r">Break-even index</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const o = r.bid === null ? null : otherSide(r.key, r.bid, band, pd, cd, scrub);
                return (
                  <tr key={r.key}>
                    <td data-label="Strategy">{r.title}</td>
                    <td className="r num" data-label="Paid now">{r.bid === null ? "no bid" : dollars(r.bid)}</td>
                    <td className="r num" data-label="Net">{o ? dollars(o.net) : "-"}</td>
                    <td className="r num" data-label="Best case">{o ? `+${dollars(o.maxGain)}` : "-"}</td>
                    <td className="r num" data-label="Worst case">{o ? `-${dollars(o.maxLoss)}` : "-"}</td>
                    <td className="r num" data-label="Break-even">{o ? `${o.wins === "below" ? "at or below" : "at or above"} $${o.breakEven.toFixed(4)}` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
