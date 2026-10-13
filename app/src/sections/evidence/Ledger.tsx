import type { ReactNode } from "react";
import { Pending } from "../../components/Pending";
import { Src } from "../../components/Src";
import type { SeriesSubject } from "../../config/types";
import { useLedger } from "../../hooks/ledger";
import { blockLabel, shortAddress, usd, utc } from "../../lib/format";
import type { Delivery, OffchainRefusal } from "../../lib/ledger";
import type { MarketSnapshot } from "../../lib/reads";
import type { SettlementRecord } from "../../lib/settlement";
import { TxLink } from "./shared";

function refusalTitle(errorName: string, reasons: string[]): string {
  const text = reasons.join(" ");
  switch (errorName) {
    case "UntrustedOperator": return "Report from an untrusted sender";
    case "UntrustedWorkflow": return "Report from the wrong workflow";
    case "UntrustedForwarder": return "Report through the wrong forwarder";
    case "AlreadySettled": return "Replay after settlement";
    case "BeforeExpiry": return "Report before the period ended";
    case "InvalidPayload": return "Malformed report payload";
    case "MarketSettled": return "Mark after settlement";
    case "InvalidMark": return /advance/.test(text) ? "Mark that does not advance" : "Mark that does not match the feed";
    case "InvalidReport":
      if (/chain/.test(text)) return "Report bound to another chain";
      if (/published .*before delivery|too old|at most/.test(text)) return "Stale report";
      return "Report that does not match the series";
    default: return "Report refused";
  }
}

function describe(d: Delivery, snapshot: MarketSnapshot): { title: string; tone: "ok" | "bad" | "warn"; chip: string } {
  const pd = snapshot.terms.priceDecimals;
  switch (d.outcome) {
    case "settled":
      return { title: `Report accepted, market settled at ${usd(snapshot.state.settlementPrice, pd, 6)}`, tone: "ok", chip: "Accepted" };
    case "mark-accepted":
      return { title: "Mark accepted", tone: "ok", chip: "Accepted" };
    case "refused": {
      const name = d.trace?.errorName ?? d.diagnosis?.errorName ?? null;
      if (name === null && d.trace?.message && /gas/.test(d.trace.message)) return { title: "Report ran out of gas inside the receiver", tone: "bad", chip: "Refused" };
      return { title: refusalTitle(name ?? "", d.diagnosis?.reasons ?? []), tone: "bad", chip: "Refused" };
    }
    case "reverted":
      return { title: "Transaction reverted at the forwarder", tone: "bad", chip: "Reverted" };
    case "unconfirmed":
      return { title: "Forwarder reported success, but nothing changed on-chain", tone: "warn", chip: "Unconfirmed" };
  }
}

function Row({ d, snapshot }: { d: Delivery; snapshot: MarketSnapshot }) {
  const { title, tone, chip } = describe(d, snapshot);
  const toneClass = tone === "ok" ? "ok" : tone === "bad" ? "bad" : "warn";
  const eventLine = d.events.length > 0 ? d.events.join(" · ") : "no events from the contracts";
  return (
    <div className={`ledger-item ${toneClass}`}>
      <span className="ledger-dot" aria-hidden />
      <div className="ledger-body">
        <h3>
          {title}
          <span className={`chip ${toneClass} plain`}>{chip}</span>
        </h3>
        <p className="sub">Events in this transaction: <span className="mono">{eventLine}</span></p>
        {d.outcome === "refused" || d.outcome === "reverted" ? (
          <>
            <p>
              <strong>
                {d.target === "settlement" ? "The market emitted no Settled event" : "The feed emitted no MarkUpdated event"}
                {d.forwarderResult === false ? ", and the forwarder logged result=false." : "."}
              </strong>
            </p>
            {d.trace?.errorName ? <p className="sub">Contract revert reason, from this node&rsquo;s transaction trace: <span className="mono">{d.trace.errorName}</span>.</p> : null}
            {d.trace && !d.trace.errorName && d.trace.message ? (
              <p className="sub">
                The node&rsquo;s transaction trace shows the receiver call ending with <span className="mono">{d.trace.message}</span>.
                {/gas/.test(d.trace.message) ? " The delivery's gas limit was too low for the receiver and the market together; a CRE workflow sets this with its gasLimit." : ""}
              </p>
            ) : null}
            {d.diagnosis ? (
              <p className="sub">
                {d.trace?.errorName ? "Re-checked against the report: " : "Reason, reconstructed from the submitted report and chain state (the forwarder discards the revert data): "}
                <span className="mono">{d.diagnosis.errorName}</span>
                {d.diagnosis.reasons.length > 0 ? `. ${d.diagnosis.reasons.join(" ")}` : null}
              </p>
            ) : d.outcome === "refused" && !d.trace ? (
              <p className="sub">Re-applying the contracts&rsquo; checks to the submitted report finds no violation, so the cause could not be reconstructed here.</p>
            ) : null}
          </>
        ) : null}
        {d.outcome === "unconfirmed" ? <p>The forwarder logged success, yet the {d.target === "settlement" ? "market" : "feed"} emitted nothing. Treat this delivery as not applied.</p> : null}
        {d.note ? <p className="sub">Operator note: {d.note}</p> : null}
        <div className="ledger-meta">
          <TxLink hash={d.txHash} />
          <span>block {blockLabel(d.blockNumber)}</span>
          <span>{utc(d.timestamp, true)}</span>
          <span>to {d.target === "settlement" ? "settlement receiver" : "mark feed"}</span>
          <span>from {shortAddress(d.sender)}</span>
        </div>
      </div>
    </div>
  );
}

function OffchainRow({ o }: { o: OffchainRefusal }) {
  return (
    <div className="ledger-item bad">
      <span className="ledger-dot" aria-hidden />
      <div className="ledger-body">
        <h3>
          {o.title}
          <span className="chip bad plain">Stopped off-chain</span>
        </h3>
        <p><strong>Refused by the workflow before anything was sent: </strong><span className="mono">{o.reason}</span>.</p>
        {o.note ? <p className="sub">{o.note}</p> : null}
        <p className="sub">This one has no transaction, so it cannot be checked on-chain. It is listed because the run reported it, and is not counted among the on-chain refusals.</p>
      </div>
    </div>
  );
}

function FallbackRow({ record, snapshot }: { record: SettlementRecord; snapshot: MarketSnapshot }) {
  return (
    <div className="ledger-item ok">
      <span className="ledger-dot" aria-hidden />
      <div className="ledger-body">
        <h3>
          Settled by the permissionless fallback at {usd(record.price, snapshot.terms.priceDecimals, 6)}
          <span className="chip warn plain">Fallback</span>
        </h3>
        <p className="sub">Events in this transaction: <span className="mono">SettledByFallback</span>. No oracle report was involved; the price is the band midpoint.</p>
        <div className="ledger-meta">
          <TxLink hash={record.txHash} />
          <span>block {blockLabel(record.blockNumber)}</span>
          <span>{utc(record.timestamp, true)}</span>
          <span>from {shortAddress(record.sender)}</span>
        </div>
      </div>
    </div>
  );
}

function Counter({ value, label, tone }: { value: number; label: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className={`counter${tone ? ` ${tone}` : ""}`}>
      <span className="counter-value num">{value}</span>
      <span className="counter-label">{label}</span>
    </div>
  );
}

export function Ledger({ subject, snapshot, settlement, settlementReady }: { subject: SeriesSubject; snapshot: MarketSnapshot; settlement: SettlementRecord | null; settlementReady: boolean }) {
  const ledger = useLedger(subject, snapshot, settlement, settlementReady);
  const data = ledger.data;
  const deliveries = data?.deliveries ?? [];
  const marks = deliveries.filter((d) => d.outcome === "mark-accepted");
  const shown = deliveries.filter((d) => d.outcome !== "mark-accepted");
  const settled = shown.filter((d) => d.outcome === "settled").length + (settlement?.kind === "fallback" ? 1 : 0);
  const refused = shown.filter((d) => d.outcome === "refused" || d.outcome === "reverted").length;
  const unconfirmed = shown.filter((d) => d.outcome === "unconfirmed").length;
  const offchain = data?.offchain ?? [];

  let body: ReactNode;
  if (ledger.isLoading || !settlementReady) body = <p className="sub">Reading forwarder, receiver and market events</p>;
  else if (ledger.isError) body = <Pending title="Could not read the delivery log">{ledger.error instanceof Error ? ledger.error.message : "RPC error"}</Pending>;
  else if (data?.blocked) body = <Pending title="Delivery log unavailable">{data.blocked}</Pending>;
  else
    body = (
      <>
        <div className="ledger">
          {offchain.map((o) => <OffchainRow key={o.title} o={o} />)}
          {shown.map((d) => <Row key={d.txHash} d={d} snapshot={snapshot} />)}
          {settlement?.kind === "fallback" ? <FallbackRow record={settlement} snapshot={snapshot} /> : null}
        </div>
        {shown.length === 0 && offchain.length === 0 && settlement?.kind !== "fallback" ? (
          <p className="sub">
            No report deliveries to this series in the scanned blocks yet. Once the CRE workflow sends one, it appears here whether it was accepted or turned away.
          </p>
        ) : null}
        {marks.length > 0 ? <p className="sub">{marks.length} accepted mark update{marks.length === 1 ? "" : "s"} in the scanned blocks; see the feed rounds below.</p> : null}
      </>
    );

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Accepted and refused reports, one ledger</span>
        <Src contract="Forwarder ReportProcessed" address={subject.contracts.forwarder} block={snapshot.block.number} />
      </div>
      <div className="panel-pad stack">
        <div className="scoreboard" role="group" aria-label="Delivery outcomes">
          <Counter value={settled} label="settled" tone="ok" />
          <Counter value={refused} label="refused on-chain (found)" tone="bad" />
          <Counter value={offchain.length} label="stopped off-chain" tone="bad" />
          <Counter value={unconfirmed} label="unconfirmed" tone="warn" />
        </div>
        <p className="callout">
          <strong>How to read this.</strong> The CRE simulation forwarder reports success even when the receiver reverts. The outer transaction succeeds either way, so nothing below comes from a transaction status or a CLI status. Each row is rebuilt from the transaction&rsquo;s own logs: the forwarder&rsquo;s{" "}
          <span className="mono">ReportProcessed(result)</span>, the receiver&rsquo;s accept event, and the market&rsquo;s <span className="mono">Settled</span> or <span className="mono">SettledByFallback</span>.
        </p>
        {body}
        {data && !data.blocked ? (
          <div className="stack" style={{ gap: 6 }}>
            {data.scan ? (
              <p className="sub num">
                Reports found in this scan (blocks {blockLabel(data.scan.fromBlock)} to {blockLabel(data.scan.toBlock)}) plus pinned records: ReportProcessed events to this series&rsquo; receiver and feed, via {data.scan.via} ({data.scan.requests} {data.scan.requests === 1 ? "query" : "queries"} of up to {data.scan.chunk.toLocaleString("en-US")} blocks).
                {settlement?.kind === "report" ? " The scan ends a few thousand blocks after the settlement transaction, so a later replay appears only if it is pinned." : ""}
                {data.scan.failedSources.length > 0 ? ` ${data.scan.failedSources.join(", ")} did not answer, so the scan fell back to ${data.scan.via} with smaller pages.` : ""}
                {data.scan.truncated ? " Older blocks were not scanned; only transactions pinned in the manifest are shown from before this window." : ""}
              </p>
            ) : (
              <p className="sub">The event scan failed on this RPC, so only pinned transactions are shown.</p>
            )}
            {data.manifestIgnored ? (
              <p className="callout warn">A pinned-transaction file exists at {subject.evidenceBase}/deliveries.json, but it names a different market, so it was ignored.</p>
            ) : null}
            <p className="sub">
              {data.manifestCount === null
                ? `No pinned-transaction manifest at ${subject.evidenceBase}/deliveries.json; discovery relies on the scan.`
                : `${data.manifestCount} pinned transaction${data.manifestCount === 1 ? "" : "s"} from ${subject.evidenceBase}/deliveries.json. A pin only locates a transaction; its outcome is still read from the chain.`}
            </p>
            <div className="row">
              <button type="button" className="btn secondary small" onClick={() => ledger.refetch()} disabled={ledger.isFetching}>{ledger.isFetching ? "Scanning" : "Rescan"}</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
