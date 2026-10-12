import { useState } from "react";
import { computeMarketAbi } from "../abi";
import { ActionButton, TxStatus } from "../components/Action";
import { Pending } from "../components/Pending";
import { Section } from "../components/Section";
import { Src } from "../components/Src";
import { config } from "../config";
import { useAction } from "../hooks/action";
import { useChainNow, useClient, useEvidenceFile, useMarket, useSettlement } from "../hooks/chain";
import { useWallet } from "../hooks/wallet";
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

function EvidencePanel({ snapshot, text, check }: { snapshot: MarketSnapshot; text: string; check: EvidenceCheck }) {
  const [raw, setRaw] = useState(false);
  const d = check.dataset;
  const slots = d ? (d.periodEnd - d.periodStart) / d.slotSeconds : 0;
  const bound = d !== null && d.indexId.toLowerCase() === snapshot.terms.indexId.toLowerCase() && d.specHash.toLowerCase() === snapshot.terms.specHash.toLowerCase();
  const periodOk = d !== null && BigInt(d.periodStart) === snapshot.terms.periodStart && BigInt(d.periodEnd) === snapshot.terms.periodEnd;
  const pd = snapshot.terms.priceDecimals;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Canonical evidence, verified in your browser</span>
        {d ? <span className={`chip ${d.mode === "DEMO" ? "warn" : "ok"} plain`}>{d.mode === "DEMO" ? "Synthetic demo data" : d.mode}</span> : null}
      </div>
      <div className="panel-pad stack">
        <div className="checks">
          <Check state={check.hashMatches ? "pass" : "fail"} detail={`file ${shortHash(check.computedHash)} vs chain ${shortHash(snapshot.state.evidenceHash)}`}>
            keccak256 of the evidence file equals the evidence hash settled on-chain
          </Check>
          <Check
            state={check.priceMatches === null ? "skip" : check.priceMatches ? "pass" : "fail"}
            detail={check.computedMean !== null ? `mean of ${d?.observations.length} observations = ${check.computedMean.toString()} raw, chain settled at ${snapshot.state.settlementPrice.toString()}` : undefined}
          >
            Equal-slot mean, rounded down, reproduces the settled price
          </Check>
          <Check state={d === null ? "skip" : bound ? "pass" : "fail"}>Evidence is bound to this series (index ID and spec hash match the market)</Check>
          <Check state={d === null ? "skip" : periodOk && d.observations.length === slots ? "pass" : "fail"} detail={d ? `${d.observations.length} of ${slots} slots, ${d.slotSeconds}s each` : undefined}>
            Observations cover the whole period with no gaps
          </Check>
        </div>

        {d ? (
          <>
            <p className="sub">
              Source <span className="mono">{d.sourceId}</span> · dataset <span className="mono">{d.datasetId}</span> · {d.hardware.model}, {d.hardware.region} · {d.units}
            </p>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Slot start (UTC)</th><th>Observed</th><th className="r">Price</th></tr></thead>
                <tbody>
                  {d.observations.slice(0, 12).map((o) => (
                    <tr key={o.slotStart}>
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
        ) : (
          <p className="callout bad">The evidence file could not be parsed: {check.parseError}</p>
        )}

        <div className="row">
          <button type="button" className="btn secondary small" onClick={() => setRaw((v) => !v)} aria-expanded={raw}>{raw ? "Hide raw JSON" : "Show raw JSON"}</button>
          <a className="btn secondary small" href={`${config.evidenceBase}/evidence.json`} download="evidence.json">Download evidence.json</a>
        </div>
        {raw ? <pre className="json-view" tabIndex={0}>{text}</pre> : null}
      </div>
    </div>
  );
}

function SettlementFacts({ snapshot, record, lookupReason }: { snapshot: MarketSnapshot; record: SettlementRecord | null; lookupReason: string | null }) {
  const pd = snapshot.terms.priceDecimals;
  const fallback = snapshot.state.settledByFallback;
  const delivery = config.settlementMode ? DELIVERY[config.settlementMode] : null;
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
                  ? "No valid report arrived in time, so the safety valve settled the market at the band midpoint. Anyone could call it; funds were never locked."
                  : delivery
                    ? `${delivery.short}. ${delivery.detail}`
                    : "Delivered by the settlement authority."}
              </div>
            </dd>
          </div>
          <div>
            <dt>Index source</dt>
            <dd><SourceNote /></dd>
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

function FallbackAction({ snapshot }: { snapshot: MarketSnapshot }) {
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  const market = useMarket();
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const opensAt = snapshot.terms.periodEnd + snapshot.terms.fallbackDelay;
  const open = now !== null && now >= opensAt;

  const run = () =>
    action.run("Fallback settlement", async () => {
      const account = wallet?.account;
      if (!wallet || !account) throw new Error("Connect a wallet first");
      const { request } = await pc.simulateContract({ account, address: snapshot.address, abi: computeMarketAbi, functionName: "settleFallback" });
      return wallet.writeContract(request);
    });

  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Safety valve</span></div>
      <div className="panel-pad stack">
        <p>
          If no valid report arrives within {duration(Number(snapshot.terms.fallbackDelay))} of the period end, <strong>anyone</strong> can settle the market at the band midpoint, {usd((snapshot.terms.lower + snapshot.terms.upper) / 2n, snapshot.terms.priceDecimals, 2)}. Funds can never be locked behind a silent oracle.
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

export function Evidence() {
  const market = useMarket();
  const snapshot = market.data;
  const settlement = useSettlement(snapshot);
  const evidence = useEvidenceFile(snapshot);
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const record = settlement.data?.status === "found" ? settlement.data.record : null;
  const phase = snapshot ? phaseOf(snapshot) : null;
  const settled = phase === "settled" || phase === "settled-fallback";
  const settlementReady = !settled || !settlement.isLoading;

  return (
    <Section
      id="evidence"
      index="05"
      kicker="Settlement evidence"
      title={
        <>
          What settled it, and what the system <em>refused</em>
        </>
      }
      lede="A settlement is only worth trusting if the failures are on the record too. The ledger puts the accepted report beside every report the contracts turned away, each rebuilt from on-chain events."
    >
      {!snapshot ? (
        <Pending title="No market deployed on this network yet">Settlement evidence appears here once a series has been deployed and has settled.</Pending>
      ) : !settled ? (
        <div className="stack-lg">
          <div className="panel">
            <div className="verdict">
              <h3>Not settled yet</h3>
              <p className="sub">
                {phase === "pre-period" || phase === "in-period"
                  ? `The period ends ${utc(snapshot.terms.periodEnd)}${now !== null ? `, in ${duration(Number(snapshot.terms.periodEnd - now))}` : ""}. After that, a CRE report can settle it.`
                  : "The period has ended. The settlement authority has not delivered a valid report."}
              </p>
            </div>
            <div className="panel-pad">
              <p className="sub">Only the settlement authority ({shortAddress(snapshot.terms.settlementAuthority)}) can settle with a report, and it can do so once. Reports must match this chain, market, index, spec and period, and be fresh.</p>
            </div>
          </div>
          <Ledger snapshot={snapshot} settlement={null} settlementReady />
          <div className="two-col">
            <FallbackAction snapshot={snapshot} />
            <Rounds snapshot={snapshot} />
          </div>
        </div>
      ) : (
        <div className="stack-lg">
          <SettlementFacts snapshot={snapshot} record={record} lookupReason={settlement.data?.status === "not-found" ? settlement.data.reason : null} />
          <Ledger snapshot={snapshot} settlement={record} settlementReady={settlementReady} />
          <div className="stack-lg">
            {snapshot.state.settledByFallback ? (
              <div className="panel">
                <div className="panel-head"><span className="label">Evidence</span></div>
                <div className="panel-pad"><p className="sub">A fallback settlement carries no dataset. The price is defined by the contract as the midpoint of the band, which anyone can verify from the floor and cap.</p></div>
              </div>
            ) : evidence.data ? (
              <EvidencePanel snapshot={snapshot} text={evidence.data.text} check={evidence.data.check} />
            ) : evidence.isLoading ? (
              <div className="panel"><div className="panel-pad"><p className="sub">Fetching the evidence file</p></div></div>
            ) : (
              <Pending title="Evidence file not published">
                Expected at <span className="mono">{config.evidenceBase}/evidence.json</span>. The on-chain hash is {shortHash(snapshot.state.evidenceHash)}; once the canonical JSON is served, it is hashed here and compared.
              </Pending>
            )}
            <Rounds snapshot={snapshot} />
            <Lifecycle snapshot={snapshot} />
          </div>
        </div>
      )}
    </Section>
  );
}
