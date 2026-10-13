import type { CSSProperties } from "react";

export interface GaugeMarker {
  value: number;
  label: string;
  tone?: "accent" | "short" | "ink";
}

interface Props {
  lower: number;
  upper: number;
  markers?: GaugeMarker[];
  money: (value: number) => string;
  ariaLabel: string;
  pulse?: boolean;
}

// Where a price sits against the payout band: floor and cap are the ends of the filled segment, the dot is the price.
// Left of the floor the short pays everything, right of the cap the long does; between them the payout slides across.
export default function BandGauge({ lower, upper, markers = [], money, ariaLabel, pulse = true }: Props) {
  const span = upper - lower;
  const lo = Math.max(0, lower - span * 0.35);
  const hi = upper + span * 0.35;
  const pos = (v: number) => `${(Math.min(Math.max((v - lo) / (hi - lo), 0), 1) * 100).toFixed(3)}%`;
  const ordered = [...markers].sort((a, b) => a.value - b.value);

  return (
    <div className="gauge" role="img" aria-label={ariaLabel} style={{ "--floor": pos(lower), "--cap": pos(upper) } as CSSProperties}>
      <div className="gauge-markers">
        {ordered.map((m, i) => (
          <span key={m.label} className={`gauge-marker gauge-marker--${m.tone ?? "accent"}`} style={{ left: pos(m.value), zIndex: i + 1 }} data-edge={m.value <= lo + (hi - lo) * 0.14 ? "start" : m.value >= hi - (hi - lo) * 0.14 ? "end" : "mid"}>
            <b className="num">{m.label}</b>
            <i className={pulse ? "dot pulse" : "dot"} />
          </span>
        ))}
      </div>
      <div className="gauge-track">
        <span className="gauge-band" />
      </div>
      <div className="gauge-ends" aria-hidden>
        <span className="gauge-end gauge-end--floor"><small>Floor</small><span className="num">{money(lower)}</span></span>
        <span className="gauge-end gauge-end--cap"><small>Cap</small><span className="num">{money(upper)}</span></span>
      </div>
      <div className="gauge-legend" aria-hidden>
        <span>Short</span>
        <span>Payout slides from short to long</span>
        <span>Long</span>
      </div>
    </div>
  );
}
