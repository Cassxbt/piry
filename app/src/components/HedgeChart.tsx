import { useMemo } from "react";
import { useWidth } from "../hooks/useWidth";
import { outcomeAt, type Exposure } from "../lib/hedge";

interface Props {
  exposure: Exposure;
  claims: bigint;
  premium: bigint;
  today: number;
  scrub: number;
  domain: [number, number];
  onScrub: (price: number) => void;
}

export function chartDomain(lower: number, upper: number, today: number): [number, number] {
  const span = upper - lower;
  return [Math.max(0, Math.min(lower - span * 0.6, today * 0.75)), Math.max(upper + span * 1.1, today * 1.2)];
}

const MARGIN = { top: 34, right: 18, bottom: 46, left: 62 };

const compactUsd = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `$${v.toFixed(0)}`;
};

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * exp;
}

export function HedgeChart({ exposure, claims, premium, today, scrub, domain, onScrub }: Props) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = Math.max(measured, 300);
  const height = width < 520 ? 300 : 360;
  const { priceDecimals: pd, collateralDecimals: cd, band } = exposure;
  const scale = 10 ** pd;
  const L = Number(band.lower) / scale;
  const U = Number(band.upper) / scale;
  const [xMin, xMax] = domain;

  const model = useMemo(() => {
    const samples = 240;
    const points = Array.from({ length: samples + 1 }, (_, i) => {
      const price = xMin + ((xMax - xMin) * i) / samples;
      const o = outcomeAt(exposure, claims, premium, BigInt(Math.round(price * scale)));
      return { price, unhedged: Number(o.unhedged) / 10 ** cd, hedged: Number(o.hedged) / 10 ** cd };
    });
    const yMax = Math.max(...points.map((p) => Math.max(p.unhedged, p.hedged))) * 1.06 || 1;
    return { points, yMax };
  }, [exposure, claims, premium, xMin, xMax, scale, cd]);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const x = (p: number) => MARGIN.left + ((p - xMin) / (xMax - xMin)) * plotW;
  const y = (v: number) => MARGIN.top + plotH - (v / model.yMax) * plotH;

  const line = (key: "unhedged" | "hedged") =>
    model.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.price).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(" ");

  // Shade between the lines: green where the hedge leaves the bill lower, rust where its premium makes it higher.
  const saving: string[] = [];
  const cost: string[] = [];
  for (let i = 0; i < model.points.length - 1; i++) {
    const a = model.points[i]!;
    const b = model.points[i + 1]!;
    const quad = `M${x(a.price).toFixed(1)} ${y(a.unhedged).toFixed(1)} L${x(b.price).toFixed(1)} ${y(b.unhedged).toFixed(1)} L${x(b.price).toFixed(1)} ${y(b.hedged).toFixed(1)} L${x(a.price).toFixed(1)} ${y(a.hedged).toFixed(1)}Z`;
    ((a.unhedged + b.unhedged) / 2 >= (a.hedged + b.hedged) / 2 ? saving : cost).push(quad);
  }

  const xStep = niceStep((xMax - xMin) / (width < 520 ? 4 : 7));
  const xTicks: number[] = [];
  for (let t = Math.ceil(xMin / xStep) * xStep; t <= xMax + 1e-9; t += xStep) xTicks.push(Number(t.toFixed(8)));
  const yStep = niceStep(model.yMax / 4);
  const yTicks: number[] = [];
  for (let t = 0; t <= model.yMax; t += yStep) yTicks.push(t);

  const at = (price: number) => {
    const o = outcomeAt(exposure, claims, premium, BigInt(Math.round(price * scale)));
    return { unhedged: Number(o.unhedged) / 10 ** cd, hedged: Number(o.hedged) / 10 ** cd };
  };
  const s = at(scrub);

  const move = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    onScrub(Number((xMin + frac * (xMax - xMin)).toFixed(4)));
  };

  const narrow = width < 520;
  const capText = narrow ? `CAP $${U.toFixed(2)}` : `CAP $${U.toFixed(2)}: hedge stops paying`;
  const capLabelLeft = x(U) + 6 + capText.length * 6.8 > width - MARGIN.right;

  return (
    <div ref={ref} className="chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Monthly GPU bill against the settlement price. Hedged bill is flat between ${L.toFixed(2)} and ${U.toFixed(2)} dollars per GPU-hour, and rises with the market above the ${U.toFixed(2)} cap.`}
      >
        <rect x={x(L)} y={MARGIN.top} width={x(U) - x(L)} height={plotH} fill="var(--long-wash)" opacity="0.55" />

        {yTicks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth="1" />
            <text x={MARGIN.left - 10} y={y(t) + 4} textAnchor="end" fontSize="11" className="num" fill="var(--ink-3)">{compactUsd(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={MARGIN.top + plotH} y2={MARGIN.top + plotH + 5} stroke="var(--ink-3)" />
            <text x={x(t)} y={MARGIN.top + plotH + 20} textAnchor="middle" fontSize="11" className="num" fill="var(--ink-3)">${t.toFixed(t % 1 === 0 ? 0 : 2)}</text>
          </g>
        ))}
        <text x={MARGIN.left + plotW / 2} y={height - 6} textAnchor="middle" fontSize="11.5" fill="var(--ink-3)">Settlement price, USD per GPU-hour</text>

        <path d={saving.join(" ")} fill="var(--long)" opacity="0.2" />
        <path d={cost.join(" ")} fill="var(--short)" opacity="0.22" />

        <line x1={x(L)} x2={x(L)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--ink)" strokeDasharray="2 4" />
        <line x1={x(U)} x2={x(U)} y1={MARGIN.top - 6} y2={MARGIN.top + plotH} stroke="var(--short)" strokeWidth="1.75" />
        <text x={x(L) - 6} y={MARGIN.top - 12} textAnchor="end" fontSize="11" className="mono" fill="var(--ink)">FLOOR ${L.toFixed(2)}</text>
        <text x={capLabelLeft ? x(U) - 6 : x(U) + 6} y={MARGIN.top - 12} textAnchor={capLabelLeft ? "end" : "start"} fontSize="11" fontWeight="600" className="mono" fill="var(--short)">{capText}</text>

        <path d={line("unhedged")} fill="none" stroke="var(--ink-3)" strokeWidth="1.75" strokeDasharray="5 4" />
        <path d={line("hedged")} fill="none" stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round" />

        <line x1={x(today)} x2={x(today)} y1={MARGIN.top + plotH - 10} y2={MARGIN.top + plotH} stroke="var(--ink)" strokeWidth="2" />
        <text x={x(today)} y={MARGIN.top + plotH - 16} textAnchor="middle" fontSize="10.5" className="mono" fill="var(--ink)">today</text>

        <line x1={x(scrub)} x2={x(scrub)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--long)" strokeWidth="1.25" />
        <circle cx={x(scrub)} cy={y(s.unhedged)} r="4.5" fill="var(--paper)" stroke="var(--ink-3)" strokeWidth="2" />
        <circle cx={x(scrub)} cy={y(s.hedged)} r="5" fill="var(--ink)" stroke="var(--paper)" strokeWidth="2" />

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          style={{ touchAction: "pan-y", cursor: "crosshair" }}
          onPointerMove={move}
          onPointerDown={move}
        />
      </svg>
    </div>
  );
}
