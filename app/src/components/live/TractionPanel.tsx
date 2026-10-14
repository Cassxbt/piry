import { config } from "../../config";
import { useTraction } from "../../hooks/traction";
import { blockLabel } from "../../lib/format";
import type { Bucket } from "../../lib/traction";
import { Pending } from "../Pending";

function volumeLabel(volume: number, complete: boolean, digits: number): string {
  const amount = `$${volume.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
  if (complete) return amount;
  return volume > 0 ? `${amount}+ (partial)` : "unavailable";
}

const ROWS: [string, (b: Bucket) => string][] = [
  ["Trades (taker orders with a positive fill)", (b) => b.trades.toLocaleString("en-US")],
  ["Positive fills", (b) => b.fills.toLocaleString("en-US")],
  ["Unique wallets", (b) => b.wallets.toLocaleString("en-US")],
  ["Volume, USDC", (b) => volumeLabel(b.volume, b.volumeComplete, 2)],
  ["Pairs minted", (b) => b.minted.toLocaleString("en-US")],
  ["Pairs merged", (b) => b.merged.toLocaleString("en-US")],
  ["Redemptions", (b) => b.redeemed.toLocaleString("en-US")],
];

const LABEL = `Read live from both Kuru books and the market contract. Our own stress-test wallets are tagged by address (${config.teamAddresses?.length ?? 0} wallets${config.teamAddressesAsOf ? `, as of ${config.teamAddressesAsOf}` : ""}); every other wallet is counted on its own.`;

export function TractionPanel() {
  const t = useTraction();
  if (t.isError) return <Pending title="Traction unavailable">The event scan failed. The ledger above is unaffected.</Pending>;
  if (!t.data) return <Pending title="Reading trades and pair events">Scanning the Kuru books and the market contract from the deployment block.</Pending>;
  const { team, unclassified } = t.data;
  return (
    <div className="traction">
      <table className="table responsive">
        <caption className="sr-only">Trading and minting activity on the Piry markets</caption>
        <thead><tr><th></th><th className="r">Stress tests</th><th className="r">Other wallets</th></tr></thead>
        <tbody>
          {ROWS.map(([label, read]) => (
            <tr key={label}>
              <td data-label="">{label}</td>
              <td className="r num" data-label="Stress tests">{read(team)}</td>
              <td className="r num" data-label="Other wallets">{read(unclassified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        {LABEL} Read from Kuru TradesPacked events on both Piry markets and ComputeMarket PairsMinted, PairsMerged and Redeemed events{t.via ? ` through ${t.via}` : ""}. A trade is classified by the wallet that took. Zero and empty fill records are not counted.
      </p>
      <p className="sub num">
        {t.range
          ? `Scanned blocks ${blockLabel(t.range.reached)} to ${blockLabel(t.range.latest)}${t.scanning ? `; still scanning back towards the start block ${blockLabel(t.range.start)}, so these figures will grow` : t.partial ? `; the scan stopped before the start block ${blockLabel(t.range.start)}, so older activity is not counted` : `, from the ComputeMarket deployment block ${blockLabel(t.range.start)}`}.`
          : null}
        {" "}Volume reads "partial" or "unavailable" when a book's price scale could not be read.
      </p>
    </div>
  );
}

export function TractionTile() {
  const t = useTraction();
  const other = t.data?.unclassified;
  const all = t.data
    ? { trades: t.data.team.trades + t.data.unclassified.trades, volume: t.data.team.volume + t.data.unclassified.volume, complete: t.data.team.volumeComplete && t.data.unclassified.volumeComplete }
    : null;
  return (
    <div>
    <dl className="cap-facts traction-tile">
      <div><dt>Trades on Kuru</dt><dd className="num">{all ? all.trades.toLocaleString("en-US") : "..."}</dd></div>
      <div><dt>Volume</dt><dd className="num">{all ? volumeLabel(all.volume, all.complete, 0) : "..."}</dd></div>
      <div><dt>Other wallets</dt><dd className="num">{other ? other.wallets.toLocaleString("en-US") : "..."}</dd></div>
      <div><dt>Stress-test wallets</dt><dd className="num">{t.data ? t.data.team.wallets.toLocaleString("en-US") : "..."}</dd></div>
    </dl>
      {t.scanning && t.range ? <p className="sub num">Still scanning, newest blocks first: {blockLabel(t.range.reached)} to {blockLabel(t.range.latest)} read so far, so these figures will grow.</p> : null}
      <p className="sub">{LABEL}</p>
    </div>
  );
}
