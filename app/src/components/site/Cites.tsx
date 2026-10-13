import type { Citation } from "../../content/whyNow";

export function Cites({ sources }: { sources: Citation[] }) {
  return (
    <p className="cites">
      Source{sources.length > 1 ? "s" : ""}:{" "}
      {sources.map((c, i) => (
        <span key={c.url}>
          {i > 0 ? "; " : ""}
          <a href={c.url} target="_blank" rel="noreferrer">{c.label}</a>
        </span>
      ))}
    </p>
  );
}
