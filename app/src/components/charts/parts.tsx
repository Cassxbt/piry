import { useId } from "react";

// One soft gradient per chart: the mark colour at ~22% at the line, fading to nothing at the baseline.
export function FadeGradient({ id, color, top = 0.22 }: { id: string; color: string; top?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={top} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

export function useGradientId(): string {
  return `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

interface PulseProps {
  cx?: number;
  cy?: number;
  color: string;
  still?: boolean;
}

// The latest point: a solid dot with a 2px surface ring, and a soft ring that pulses outward unless motion is reduced.
export function PulseDot({ cx, cy, color, still }: PulseProps) {
  if (cx === undefined || cy === undefined || Number.isNaN(cx) || Number.isNaN(cy)) return <g />;
  return (
    <g pointerEvents="none">
      {still ? null : <circle className="pulse-ring" cx={cx} cy={cy} r={6} fill={color} />}
      <circle cx={cx} cy={cy} r={4.5} fill={color} stroke="var(--chart-surface)" strokeWidth={2} />
    </g>
  );
}

export const compactUsd = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `$${v.toFixed(a < 10 && v % 1 !== 0 ? 2 : 0)}`;
};

// Round tick values that stay inside a padded domain, so axis labels are clean numbers.
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * exp;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}

// A domain never shows less than `minSpan`, so a half-percent move in the index reads as the small move it is.
export function paddedDomain(values: readonly number[], clamp?: [number, number], minSpan = 0): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.18, (minSpan - (hi - lo)) / 2, 0);
  let a = lo - pad;
  let b = hi + pad;
  if (clamp) {
    a = Math.max(clamp[0], a);
    b = Math.min(clamp[1], b);
  }
  return [a, b];
}
