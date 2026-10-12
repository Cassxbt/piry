import { Src } from "../../components/Src";
import { config } from "../../config";
import { useLifecycle } from "../../hooks/lifecycle";
import { blockLabel, utc } from "../../lib/format";
import type { MarketSnapshot } from "../../lib/reads";
import { TxLink } from "./shared";

export function Lifecycle({ snapshot }: { snapshot: MarketSnapshot }) {
  const lifecycle = useLifecycle(snapshot);
  const data = lifecycle.data;
  if (!data) return null;
  const withTx = data.steps.filter((s) => s.step.tx);
  if (withTx.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Run log, checked transaction by transaction</span>
        <a className="src" href={`${config.evidenceBase}/lifecycle.json`} target="_blank" rel="noreferrer">lifecycle.json</a>
      </div>
      <div className="panel-pad stack">
        <p className="sub">
          The step descriptions come from the run&rsquo;s own log. Each transaction hash is looked up on {config.chain.name} and its status, block and events are read from the receipt, so the log is a pointer and the chain is the proof.
        </p>
        <div className="lc">
          {data.steps.map(({ step, proof }) => (
            <div className="lc-row" key={step.step + (step.tx ?? "")}>
              <span className="lc-step">{step.step}</span>
              <div className="lc-proof">
                {step.tx ? <TxLink hash={step.tx} /> : <span className="sub">No transaction, nothing to check on-chain.</span>}
                {proof ? (
                  <>
                    <span className={`chip ${proof.status === "success" ? "ok" : "bad"} plain`}>{proof.status}</span>
                    <span className="sub num">block {blockLabel(proof.blockNumber)} · {utc(proof.timestamp, true)}</span>
                    <span className="mono sub">{proof.events.length > 0 ? proof.events.join(", ") : "no events from Piry contracts"}</span>
                  </>
                ) : step.tx ? (
                  <span className="sub">reading</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <Src contract="Forwarder, market, feed receipts" address={config.contracts.forwarder} block={snapshot.block.number} />
      </div>
    </div>
  );
}
