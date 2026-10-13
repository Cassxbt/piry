import { useTraction } from "../../hooks/traction";
import type { Bucket } from "../../lib/traction";
import { Pending } from "../Pending";

const ROWS: [string, (b: Bucket) => string][] = [
  ["Trades (taker orders that matched)", (b) => b.trades.toLocaleString("en-US")],
  ["Fills", (b) => b.fills.toLocaleString("en-US")],
  ["Unique wallets", (b) => b.wallets.toLocaleString("en-US")],
  ["Volume, USDC", (b) => `$${b.volume.toLocaleString("en-US", { maximumFractionDigits: 2 })}`],
  ["Pairs minted", (b) => b.minted.toLocaleString("en-US")],
  ["Pairs merged", (b) => b.merged.toLocaleString("en-US")],
  ["Redemptions", (b) => b.redeemed.toLocaleString("en-US")],
];

const LABEL = "Team test activity is labelled; external = any other wallet.";

export function TractionPanel() {
  const t = useTraction();
  if (t.isError) return <Pending title="Traction unavailable">The event scan failed. The ledger above is unaffected.</Pending>;
  if (!t.data) return <Pending title="Reading trades and pair events">Scanning the Kuru books and the market contract from the deployment block.</Pending>;
  const { team, external } = t.data;
  return (
    <div className="traction">
      <table className="table responsive">
        <caption className="sr-only">Trading and minting activity on the Piry markets</caption>
        <thead><tr><th></th><th className="r">Team</th><th className="r">External</th></tr></thead>
        <tbody>
          {ROWS.map(([label, read]) => (
            <tr key={label}>
              <td data-label="">{label}</td>
              <td className="r num" data-label="Team">{read(team)}</td>
              <td className="r num" data-label="External">{read(external)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        {LABEL} Read from Kuru TradesPacked events on both Piry markets and ComputeMarket PairsMinted, PairsMerged and Redeemed events{t.via ? ` through ${t.via}` : ""}. A trade is classified by the wallet that took.
        {t.partial ? " The scan stopped before the deployment block, so older activity is not counted." : ""}
      </p>
    </div>
  );
}

export function TractionTile() {
  const t = useTraction();
  const ext = t.data?.external;
  const all = t.data ? { trades: t.data.team.trades + t.data.external.trades, volume: t.data.team.volume + t.data.external.volume } : null;
  return (
    <div>
    <dl className="cap-facts traction-tile">
      <div><dt>Trades on Kuru</dt><dd className="num">{all ? all.trades.toLocaleString("en-US") : "..."}</dd></div>
      <div><dt>Volume</dt><dd className="num">{all ? `$${all.volume.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "..."}</dd></div>
      <div><dt>External wallets</dt><dd className="num">{ext ? ext.wallets.toLocaleString("en-US") : "..."}</dd></div>
      <div><dt>Team wallets</dt><dd className="num">{t.data ? t.data.team.wallets.toLocaleString("en-US") : "..."}</dd></div>
    </dl>
      <p className="sub">{LABEL}</p>
    </div>
  );
}
