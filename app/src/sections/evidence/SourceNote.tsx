import { config } from "../../config";

// All wording comes from config, so a deployment can change its index description without a code change.
export function SourceNote() {
  const { source, dataMode } = config.series;
  const band = source.sanityBand;
  const demo = dataMode === "DEMO";
  return (
    <div className="stack" style={{ gap: 6 }}>
      {demo ? (
        <>
          <span className="callout warn">
            <strong>This deployment runs on synthetic demo data.</strong> {source.demo ?? "No real price source is attached."}
          </span>
          <span>Intended live index: {source.name}</span>
          <span className="sub">{source.summary}</span>
        </>
      ) : (
        <>
          <span>{source.name}</span>
          <span className="sub">{source.summary}</span>
        </>
      )}
      {band ? (
        <span className="sub">
          Sanity band: {band.url ? <a href={band.url} target="_blank" rel="noreferrer">{band.name}</a> : band.name} ({band.license}
          {band.value ? `, $${band.value}${band.asOf ? ` as of ${band.asOf}` : ""}` : ""}). {band.note}
        </span>
      ) : null}
    </div>
  );
}
