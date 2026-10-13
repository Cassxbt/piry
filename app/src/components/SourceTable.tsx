import type { IndexComponent } from "../config/types";
import { fixed } from "../lib/format";
import { medianOfValid, summarizeSources } from "../lib/indexSources";

const STATUS_LABEL = { pending: "Not recorded", valid: "Valid", failed: "Failed" } as const;
const TONE = { pending: "plain", valid: "ok", failed: "bad" } as const;

interface Props {
  components: readonly IndexComponent[];
  minValid: number | null;
  asOf: string | null;
  decimals?: number;
  // The index price the chain holds (feed round or settlement), to cross-check the recorded values against.
  onchain?: { price: bigint; label: string } | null;
}

// Renders a dated snapshot of the composite's sources from config. The live index and the settled price are always read
// from the chain.
export function SourceTable({ components, minValid, asOf, decimals = 6, onchain = null }: Props) {
  if (components.length === 0) return null;
  const summary = summarizeSources(components, minValid);
  const median = summary.quorum === false ? null : medianOfValid(components, decimals);
  return (
    <div className="sources">
      <table className="table responsive">
        <caption className="sr-only">Sources behind the composite index</caption>
        <thead>
          <tr><th>Source</th><th className="r">Price, USD per GPU-hour</th><th>Status</th></tr>
        </thead>
        <tbody>
          {components.map((c) => (
            <tr key={c.name}>
              <td data-label="Source">
                <span>
                  {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}
                  {c.detail ? <span className="sub" style={{ display: "block" }}>{c.detail}</span> : null}
                </span>
              </td>
              <td className="r num" data-label="Price">{c.value !== null ? `$${c.value}` : "n/a"}</td>
              <td data-label="Status"><span className={`chip ${TONE[c.status]}${c.status === "pending" ? " plain" : ""}`}>{STATUS_LABEL[c.status]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        {minValid !== null ? `Rule: the median of the valid sources, and only if at least ${minValid} of ${summary.total} are valid. ` : ""}
        {summary.pending === summary.total
          ? "No readings are recorded for this series yet."
          : `Recorded: ${summary.valid} valid, ${summary.failed} failed${summary.pending > 0 ? `, ${summary.pending} not yet recorded` : ""}${summary.quorum === null ? "" : summary.quorum ? ", so the rule is met" : ", so the rule is not met"}.`}
        {asOf ? ` Snapshot ${asOf}; the live index is the on-chain feed.` : ""}
      </p>
      {median !== null && onchain ? (
        <p className={`callout${median === onchain.price ? " ok" : ""}`} role="status">
          <strong>Cross-check against the chain.</strong> The median of the recorded valid sources is ${fixed(median, decimals, 6)}.{" "}
          {median === onchain.price
            ? `${onchain.label} holds $${fixed(onchain.price, decimals, 6)}: they match to the unit.`
            : `${onchain.label} holds $${fixed(onchain.price, decimals, 6)}, the live feed has moved since this snapshot. The feed is the index; the table is a dated record of the sources.`}
        </p>
      ) : null}
    </div>
  );
}
