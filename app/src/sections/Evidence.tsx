import { useState } from "react";
import { computeMarketAbi } from "../abi";
import { ActionButton, TxStatus } from "../components/Action";
import { Pending } from "../components/Pending";
import { Src } from "../components/Src";
import { config } from "../config";
import type { SeriesSubject } from "../config/types";
import { useAction } from "../hooks/action";
import { useChainNow, useClient, useEvidenceFile, useSeriesMarket, useSettlement } from "../hooks/chain";
import { blockLabel, duration, shortAddress, shortHash, usd, utc } from "../lib/format";
import { DELIVERY } from "../lib/labels";
import { phaseOf, type MarketSnapshot } from "../lib/reads";
import type { SettlementRecord } from "../lib/settlement";
import type { EvidenceCheck } from "../lib/evidence";
import { Ledger } from "./evidence/Ledger";
import { Lifecycle } from "./evidence/Lifecycle";
import { Rounds } from "./evidence/Rounds";
import { TxLink } from "./evidence/shared";
import { SourceNote } from "./evidence/SourceNote";

function Check({ state, children, detail }: { state: "pass" | "fail" | "skip"; children: string; detail?: string }) {
  return (
    <div className={`check ${state}`}>
      <span className="mark" aria-hidden>{state === "pass" ? "OK" : state === "fail" ? "NO" : "--"}</span>
      <span>
        {children}
        {detail ? <span className="sub" style={{ display: "block" }}>{detail}</span> : null}
      </span>
      <span className="sr-only">{state === "pass" ? "passed" : state === "fail" ? "failed" : "not checked"}</span>
    </div>
  );
}

const STATE_CHIP: Record<EvidenceCheck["state"], { tone: "ok" | "bad" | "warn"; label: string }> = {
  verified: { tone: "ok", label: "Verified in your browser" },
  failed: { tone: "bad", label: "Verification failed" },
  unverified: { tone: "warn", label: "Reported but not verified" },
};

const SOURCE_NAMES: Record<string, string> = { akash: "Akash Console", runpod: "RunPod", shadeform: "Shadeform", verda: "Verda" };

export function EvidencePanel({ subject, snapshot, text, check, url }: { subject: SeriesSubject; snapshot: MarketSnapshot; text: string; check: EvidenceCheck; url: string }) {
  const [raw, setRaw] = useState(false);
  const d = check.dataset;
  const c = check.composite;
  const pd = snapshot.terms.priceDecimals;
  const chip = STATE_CHIP[check.state];

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Canonical evidence, checked in your browser</span>
        <span className="row">
          <span className={`chip ${chip.tone} plain`}>{chip.label}</span>
          {d?.mode === "DEMO" ? <span className="chip warn plain">Synthetic demo data</span> : check.methodology ? <span className="chip plain">{check.methodology}</span> : null}
        </span>
      </div>
      <div className="panel-pad stack">
        <div className="checks">
          {check.checks.map((item) => (
            <Check key={item.id} state={item.state} detail={item.detail}>{item.label}</Check>
          ))}
        </div>
        {check.state === "unverified" ? (
          <p className="callout warn">This page cannot re-derive the price from this file. The hash match shows these are the bytes the chain refers to; it does not show where the price came from.</p>
        ) : null}
        {check.state === "failed" ? <p className="callout bad">At least one check failed. Do not treat this settlement as verified by this page.</p> : null}

        {d ? (
          <>
            <p className="sub">
              Source <span className="mono">{d.sourceId}</span> · dataset <span className="mono">{d.datasetId}</span> · {d.hardware.model}, {d.hardware.region} · {d.units}
            </p>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Slot start (UTC)</th><th>Observed</th><th className="r">Price</th></tr></thead>
                <tbody>
                  {d.observations.slice(0, 12).map((o, i) => (
                    <tr key={`${i}-${o.slotStart}`}>
                      <td className="num" data-label="Slot start">{utc(o.slotStart)}</td>
                      <td className="num" data-label="Observed">{utc(o.observedAt, true)}</td>
                      <td className="r num" data-label="Price">{usd(BigInt(o.price), pd, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.observations.length > 12 ? <p className="sub">First 12 of {d.observations.length} observations. The raw file has them all.</p> : null}
          </>
        ) : c ? (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Source</th><th className="r">Price (per GPU-hour)</th><th className="r">Count</th></tr></thead>
                <tbody>
                  {Object.entries(c.sources).map(([name, entry]) => (
                    <tr key={name}>
                      <td data-label="Source">{SOURCE_NAMES[name] ?? name}</td>
                      <td className="r num" data-label="Price">{entry.ok ? usd(BigInt(entry.value), pd, 4) : `not used: ${entry.reason}`}</td>
                      <td className="r num" data-label="Count">{entry.ok ? entry.count : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub num">
              Snapshot time {utc(c.observedAt, true)}. This is the time the workflow recorded when it fetched the sources, not a measurement time published by the providers. Matching the hash proves the bytes, not that the providers' prices were true.
            </p>
          </>
        ) : check.parseError ? (
          <p className="callout bad">The evidence file could not be read: {check.parseError}</p>
        ) : null}

        <div className="row">
          <button type="button" className="btn secondary small" onClick={() => setRaw((v) => !v)} aria-expanded={raw}>{raw ? "Hide raw JSON" : "Show raw JSON"}</button>
          <a className="btn secondary small" href={url} download={`${subject.id ?? "live"}-evidence.json`}>Download evidence.json</a>
        </div>
        {raw ? <pre className="json-view" tabIndex={0}>{text}</pre> : null}
      </div>
    </div>
  );
}

function SettlementFacts({ subject, snapshot, record, lookupReason }: { subject: SeriesSubject; snapshot: MarketSnapshot; record: SettlementRecord | null; lookupReason: string | null }) {
  const pd = snapshot.terms.priceDecimals;
  const fallback = snapshot.state.settledByFallback;
  const delivery = subject.settlementMode ? DELIVERY[subject.settlementMode] : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Settlement record</span>
        <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
      </div>
      <div className="panel-pad">
        <dl className="kv">
          <div>
            <dt>Settled price</dt>
            <dd><span className="num" style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 330 }}>{usd(snapshot.state.settlementPrice, pd, 6)}</span><span className="sub num"> per GPU-hour, raw {snapshot.state.settlementPrice.toString()}</span></dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd>
              {fallback ? (
                <span className="chip warn">SettledByFallback</span>
              ) : (
                <span className="chip ok">Settled by report</span>
              )}
              <div className="sub" style={{ marginTop: 6 }}>
                {fallback
                  ? "No valid report was delivered within the grace period, so the fallback settled the market at the band midpoint. Anyone could call it, the first settlement won, and the midpoint is a fixed split of the band, not a recovered fair price."
                  : delivery
                    ? `${delivery.short}. ${delivery.detail}`
                    : "Delivered by the settlement authority."}
              </div>
            </dd>
          </div>
          <div>
            <dt>Index source</dt>
            <dd><SourceNote subject={subject} /></dd>
          </div>
          <div>
            <dt>Evidence hash</dt>
            <dd>
              <span className="hash">{snapshot.state.evidenceHash}</span>
              {fallback ? <div className="sub">The constant FALLBACK_EVIDENCE_HASH: there is no dataset behind a fallback settlement.</div> : null}
            </dd>
          </div>
          <div>
            <dt>{fallback ? "Settled at" : "Published at"}</dt>
            <dd className="num">{utc(snapshot.state.reportPublishedAt, true)}</dd>
          </div>
          <div>
            <dt>CRE transaction</dt>
            <dd>
              {record ? (
                <div className="stack" style={{ gap: 3 }}>
                  <TxLink hash={record.txHash} />
                  <span className="sub num">block {blockLabel(record.blockNumber)} · {utc(record.timestamp, true)}</span>
                  <span className="sub num">sent by {shortAddress(record.sender)}{record.to ? `, to ${shortAddress(record.to)}` : ""}</span>
                  {record.receiverEvent ? <span className="sub num">{record.receiverEvent.name} emitted by {shortAddress(record.receiverEvent.address)}</span> : null}
                </div>
              ) : (
                <span className="pending-inline">{lookupReason ?? "Looking up the settlement transaction"}</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function FallbackAction({ subject, snapshot }: { subject: SeriesSubject; snapshot: MarketSnapshot }) {
  const pc = useClient();
  const action = useAction();
  const market = useSeriesMarket(subject);
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const opensAt = snapshot.terms.periodEnd + snapshot.terms.fallbackDelay;
  const open = now !== null && now >= opensAt;

  const run = () =>
    action.run("Fallback settlement", async (op) => {
      const wallet = await op.wallet();
      const { request } = await pc.simulateContract({ account: wallet.account, address: snapshot.address, abi: computeMarketAbi, functionName: "settleFallback" });
      return wallet.writeContract(request);
    });

  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Safety valve</span></div>
      <div className="panel-pad stack">
        <p>
          If no valid report arrives within {duration(Number(snapshot.terms.fallbackDelay))} of the period end, <strong>anyone</strong> can settle the market at the band midpoint, {usd((snapshot.terms.lower + snapshot.terms.upper) / 2n, snapshot.terms.priceDecimals, 2)}. Until it opens, a holder of one leg cannot redeem. The first settlement wins, so a ready report can lose the race to the fallback, and the midpoint is a fixed split of the band, not the fair price. That gives a holder on the losing side a reason to stay silent until the window opens.
        </p>
        <p className="sub num">
          {open ? "The window is open." : `Opens ${utc(opensAt)}${now !== null ? `, in ${duration(Number(opensAt - now))}` : ""}.`}
        </p>
        {open ? <ActionButton label="Settle by fallback" busy={action.busy} onRun={run} /> : null}
        <TxStatus state={action.state} />
      </div>
    </div>
  );
}

function SubjectEvidence({ subject }: { subject: SeriesSubject }) {
  const market = useSeriesMarket(subject);
  const snapshot = market.data;
  const settlement = useSettlement(snapshot, subject);
  const evidence = useEvidenceFile(snapshot, subject);
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const record = settlement.data?.status === "found" ? settlement.data.record : null;
  const phase = snapshot ? phaseOf(snapshot) : null;
  const settled = phase === "settled" || phase === "settled-fallback";
  const settlementReady = !settled || !settlement.isLoading;

  return (
    <div className="subject stack-lg">
      <header className="subject-head">
        <div>
          <h3 className="subject-title">{subject.evidenceTitle}</h3>
          {subject.series.dataMode === "DEMO" ? <p className="sub">Synthetic prices on a five-minute clock, built to show the whole lifecycle on the record.</p> : <p className="sub">Real public price data, delivered by the CRE CLI in simulation.</p>}
        </div>
        <div className="row">
          {snapshot ? <span className={`chip ${settled ? "ok" : "warn"}`}>{settled ? "Settled" : "Not settled"}</span> : null}
          {subject.contracts.market ? <Src contract="ComputeMarket" address={subject.contracts.market} block={snapshot?.block.number ?? null} /> : null}
        </div>
      </header>

      {!snapshot ? (
        market.isError ? <Pending title="Could not read this series">{market.error instanceof Error ? market.error.message : "RPC error"}</Pending>
          : <Pending title="No market deployed for this series yet">Settlement evidence appears here once the series has been deployed and has settled.</Pending>
      ) : !settled ? (
        <>
          <div className="panel">
            <div className="verdict">
              <h3>Not settled yet</h3>
              <p className="sub">
                {phase === "pre-period" || phase === "in-period"
                  ? `The period ends ${utc(snapshot.terms.periodEnd)}${now !== null ? `, in ${duration(Number(snapshot.terms.periodEnd - now))}` : ""}. After that, a CRE report can settle it.`
                  : "The period has ended. The settlement authority has not delivered a valid report."}
              </p>
            </div>
            <div className="panel-pad stack">
              <p className="sub">Only the settlement authority ({shortAddress(snapshot.terms.settlementAuthority)}) can settle with a report, and it can do so once. Reports must match this chain, market, index, spec and period, and be fresh.</p>
              <dl className="kv"><div><dt>Index source</dt><dd><SourceNote subject={subject} /></dd></div></dl>
            </div>
          </div>
          <Ledger subject={subject} snapshot={snapshot} settlement={null} settlementReady />
          <div className="two-col">
            <FallbackAction subject={subject} snapshot={snapshot} />
            <Rounds subject={subject} snapshot={snapshot} />
          </div>
        </>
      ) : (
        <>
          <SettlementFacts subject={subject} snapshot={snapshot} record={record} lookupReason={settlement.data?.status === "not-found" ? settlement.data.reason : null} />
          <Ledger subject={subject} snapshot={snapshot} settlement={record} settlementReady={settlementReady} />
          {snapshot.state.settledByFallback ? (
            <div className="panel">
              <div className="panel-head"><span className="label">Evidence</span></div>
              <div className="panel-pad"><p className="sub">A fallback settlement carries no dataset. The price is defined by the contract as the midpoint of the band, which anyone can verify from the floor and cap.</p></div>
            </div>
          ) : evidence.data?.check ? (
            <EvidencePanel subject={subject} snapshot={snapshot} text={evidence.data.text} check={evidence.data.check} url={evidence.data.url} />
          ) : evidence.isLoading ? (
            <div className="panel"><div className="panel-pad"><p className="sub">Fetching the evidence file</p></div></div>
          ) : (
            <Pending title="Evidence unavailable: file not published">
              The settlement report carries hash {shortHash(snapshot.state.evidenceHash)}, but the file behind it was not found at <span className="mono">{evidence.data?.url ?? subject.evidenceBase}</span>. Nothing can be verified until it is served, and this page checks again every 30 seconds. Until then the settled price rests on the report alone.
            </Pending>
          )}
          <Rounds subject={subject} snapshot={snapshot} />
          <Lifecycle subject={subject} snapshot={snapshot} />
        </>
      )}
    </div>
  );
}

export function EvidenceBody() {
  return (
    <div className="stack-lg subjects">
      {config.subjects.map((subject) => (
        <SubjectEvidence key={subject.id ?? "live"} subject={subject} />
      ))}
    </div>
  );
}
