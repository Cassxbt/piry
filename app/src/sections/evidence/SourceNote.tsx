import { SourceTable } from "../../components/SourceTable";
import { useSeriesMark } from "../../hooks/chain";
import type { Mark } from "../../lib/reads";
import type { SeriesSubject } from "../../config/types";

// All wording comes from config, so a deployment can change its index description without a code change.
export function SourceNote({ subject }: { subject: SeriesSubject }) {
  const { source, dataMode } = subject.series;
  const band = source.sanityBand;
  const demo = dataMode === "DEMO";
  const mark = useSeriesMark(subject).data as Mark | undefined;
  const onchain = mark?.status === "ok" && mark.indexPrice !== null ? { price: mark.indexPrice, label: `Feed round ${mark.roundId.toString()}` } : null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {demo ? (
        <span className="callout warn">
          <strong>This deployment runs on synthetic demo data.</strong> {source.demo ?? "No real price source is attached."}
        </span>
      ) : null}
      <span>{demo ? `Intended live index: ${source.name}` : source.name}</span>
      <span className="sub">{source.summary}</span>
      <SourceTable components={source.components} minValid={source.minValid} asOf={source.componentsAsOf} onchain={onchain} />
      {band ? (
        <span className="sub">
          Sanity band: {band.url ? <a href={band.url} target="_blank" rel="noreferrer">{band.name}</a> : band.name}
          {band.value ? `, $${band.value}` : ""}
          {band.asOf ? `, ${band.asOf}` : ""} ({band.license}). {band.note}
        </span>
      ) : null}
    </div>
  );
}
