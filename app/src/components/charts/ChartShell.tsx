import { useId, type ReactNode } from "react";
import type { Change } from "../../lib/feedHistory";

export interface PillOption<T extends string> {
  id: T;
  label: string;
  title?: string;
}

export function Pills<T extends string>({ options, value, onChange, label }: { options: readonly PillOption<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="pills" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChangeBadge({ change, format, suffix, goodWhen = "up" }: { change: Change; format: (n: number) => string; suffix?: string; goodWhen?: "up" | "down" | "neutral" }) {
  const arrow = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "–";
  const tone = change.direction === "flat" || goodWhen === "neutral" ? "flat" : change.direction === goodWhen ? "good" : "bad";
  const text = change.direction === "flat" ? "No change" : `${change.delta > 0 ? "+" : "-"}${format(Math.abs(change.delta))}${change.pct !== null ? ` (${Math.abs(change.pct).toFixed(change.pct !== 0 && Math.abs(change.pct) < 0.1 ? 2 : 1)}%)` : ""}`;
  return (
    <span className={`chart-badge chart-badge--${tone}`}>
      <i aria-hidden>{arrow}</i>
      <span>{text}</span>
      {suffix ? <small>{suffix}</small> : null}
    </span>
  );
}

interface ShellProps {
  label: string;
  tabs?: ReactNode;
  value: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  pills?: ReactNode;
  source?: ReactNode;
  table?: ReactNode;
  tableLabel?: string;
  surface?: "paper" | "sheet";
  className?: string;
}

// The chart shell: a large current value and change above a borderless plot, range pills below, a source line and a
// table view that carries every number the chart shows.
export function ChartShell({ label, tabs, value, badge, sub, children, pills, source, table, tableLabel = "Table view", surface = "paper", className = "" }: ShellProps) {
  const id = useId();
  return (
    <figure className={`chart chart--${surface} ${className}`} aria-labelledby={`${id}-label`}>
      <header className="chart-head">
        <div className="chart-label-row">
          <p className="chart-label" id={`${id}-label`}>{label}</p>
          {tabs}
        </div>
        <div className="chart-value-row">
          <span className="chart-value">{value}</span>
          {badge}
        </div>
        {sub ? <p className="chart-sub">{sub}</p> : null}
      </header>
      <div className="chart-plot">{children}</div>
      {pills || source ? (
        <div className="chart-foot">
          <div className="chart-pills">{pills}</div>
          {source ? <div className="chart-src">{source}</div> : null}
        </div>
      ) : null}
      {table ? (
        <details className="chart-table">
          <summary>{tableLabel}</summary>
          <div className="table-wrap">{table}</div>
        </details>
      ) : null}
    </figure>
  );
}
