import { useId } from "react";
import { useWidth } from "../hooks/useWidth";

export interface RulerMarker {
  value: number;
  label: string;
  tone: "ink" | "long" | "short";
}

interface Props {
  lower: number;
  upper: number;
  markers?: RulerMarker[];
  money: (value: number) => string;
  ariaLabel: string;
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * exp;
}

const PAD = 22;
const HEIGHT = 118;
const TRACK_Y = 48;

// The product in one picture: left of the floor the short leg takes everything, right of the cap the long
// leg does, and between them the payout slides from one side to the other.
export function BandRuler({ lower, upper, markers = [], money, ariaLabel }: Props) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const gradientId = useId();
  const width = Math.max(measured, 280);
  const span = upper - lower;
  const lo = Math.max(0, lower - span * 0.32);
  const hi = upper + span * 0.32;
  const x = (v: number) => PAD + ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (width - PAD * 2);

  const step = niceStep((hi - lo) / 7);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) ticks.push(Number(t.toFixed(10)));
  const tickPx = (step / (hi - lo)) * (width - PAD * 2);
  const labelEvery = Math.max(1, Math.ceil(46 / tickPx));
  const compact = width < 520;
  const xl = x(lower);
  const xu = x(upper);

  const tone = (t: RulerMarker["tone"]) => (t === "long" ? "var(--long)" : t === "short" ? "var(--short)" : "var(--ink)");

  return (
    <div ref={ref} className="ruler">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--short)" }} />
            <stop offset="1" style={{ stopColor: "var(--long)" }} />
          </linearGradient>
        </defs>

        <rect x={PAD} y={TRACK_Y} width={Math.max(0, xl - PAD)} height={12} fill="var(--short)" opacity="0.88" />
        <rect x={xl} y={TRACK_Y} width={Math.max(0, xu - xl)} height={12} fill={`url(#${gradientId})`} />
        <rect x={xu} y={TRACK_Y} width={Math.max(0, width - PAD - xu)} height={12} fill="var(--long)" opacity="0.88" />
        <rect x={xl} y={TRACK_Y - 0.5} width={Math.max(0, xu - xl)} height={13} fill="none" stroke="var(--ink)" strokeWidth="1" />

        {ticks.map((t, i) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TRACK_Y + 16} y2={TRACK_Y + 21} stroke="var(--ink-3)" strokeWidth="1" />
            {i % labelEvery === 0 ? (
              <text x={x(t)} y={TRACK_Y + 35} textAnchor="middle" className="num" fontSize="10.5" fill="var(--ink-3)">
                {money(t)}
              </text>
            ) : null}
          </g>
        ))}

        <g fontSize="10.5" fill="var(--ink)" className="mono" letterSpacing="0.06em">
          <line x1={xl} x2={xl} y1={TRACK_Y + 14} y2={TRACK_Y + 62} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" />
          <line x1={xu} x2={xu} y1={TRACK_Y + 14} y2={TRACK_Y + 62} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" />
          <text x={compact ? xl + 5 : xl - 5} y={TRACK_Y + 58} textAnchor={compact ? "start" : "end"}>FLOOR {money(lower)}</text>
          <text x={compact ? xu - 5 : xu + 5} y={TRACK_Y + 58} textAnchor={compact ? "end" : "start"}>CAP {money(upper)}</text>
        </g>

        {markers.map((m) => {
          const mx = x(m.value);
          const anchor = mx < PAD + 52 ? "start" : mx > width - PAD - 52 ? "end" : "middle";
          return (
            <g key={m.label}>
              <path d={`M${mx - 6} ${TRACK_Y - 12} L${mx + 6} ${TRACK_Y - 12} L${mx} ${TRACK_Y - 2} Z`} fill={tone(m.tone)} />
              <line x1={mx} x2={mx} y1={TRACK_Y - 2} y2={TRACK_Y + 12} stroke={tone(m.tone)} strokeWidth="1.5" />
              <text x={mx} y={TRACK_Y - 20} textAnchor={anchor} fontSize="11.5" fontWeight="600" fill={tone(m.tone)} className="num">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
