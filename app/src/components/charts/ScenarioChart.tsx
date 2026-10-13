import { useMemo } from "react";
import { Area, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";
import { useMedia } from "../../hooks/useMedia";
import { outcomeAt, type Exposure } from "../../lib/hedge";
import type { Change } from "../../lib/feedHistory";
import { trimmed } from "../../lib/numbers";
import { ChangeBadge, ChartShell } from "./ChartShell";
import { compactUsd, FadeGradient, niceTicks, PulseDot, useGradientId } from "./parts";

interface Props {
  exposure: Exposure;
  claims: bigint;
  premium: bigint;
  today: number;
  scrub: number;
  domain: [number, number];
  onScrub: (price: number) => void;
  label?: string;
  height?: number;
  surface?: "paper" | "sheet";
}

interface Sample {
  price: number;
  unhedged: number;
  hedged: number;
  payout: number;
}

const SAMPLES = 160;

function sampleAt(exposure: Exposure, claims: bigint, premium: bigint, price: number): Sample {
  const o = outcomeAt(exposure, claims, premium, BigInt(Math.round(price * 10 ** exposure.priceDecimals)));
  const cd = 10 ** exposure.collateralDecimals;
  return { price, unhedged: Number(o.unhedged) / cd, hedged: Number(o.hedged) / cd, payout: Number(o.payout) / cd };
}
// Whole dollars, truncated like the rest of the app's money formatting, so the headline matches the figures beside it.
const usd0 = (n: number) => `$${Math.floor(n + 1e-9).toLocaleString("en-US")}`;

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Sample }[] }) {
  const s = payload?.[0]?.payload;
  if (!active || !s) return null;
  return (
    <div className="chart-tip">
      <p className="chart-tip-time">Index settles at</p>
      <p className="chart-tip-value">${trimmed(s.price, 2, 2)}</p>
      <p className="chart-tip-row"><span><i style={{ background: "var(--chart-accent)" }} />Net bill</span><b className="num">{usd0(s.hedged)}</b></p>
      <p className="chart-tip-row"><span><i style={{ background: "var(--chart-context)" }} />Unhedged</span><b className="num">{usd0(s.unhedged)}</b></p>
      <p className="chart-tip-row"><span>Claims pay</span><b className="num">{usd0(s.payout)}</b></p>
    </div>
  );
}

// Monthly GPU bill against the settlement price. The hedged line is flat across the band and rises with the market only
// above the cap; the unhedged line is the same bill with no claims. Every value is outcomeAt(), the same integer math
// the contract's payouts use, sampled across the window.
export default function ScenarioChart({ exposure, claims, premium, today, scrub, domain, onScrub, label = "Monthly bill if the index settles at", height = 300, surface = "paper" }: Props) {
  const reduce = useReducedMotion();
  const narrow = useMedia("(max-width: 520px)");
  const gradient = useGradientId();
  const { priceDecimals: pd, band } = exposure;
  const scale = 10 ** pd;
  const L = Number(band.lower) / scale;
  const U = Number(band.upper) / scale;
  const [xMin, xMax] = domain;

  const at = (price: number) => sampleAt(exposure, claims, premium, price);
  const samples = useMemo(
    () => Array.from({ length: SAMPLES + 1 }, (_, i) => sampleAt(exposure, claims, premium, xMin + ((xMax - xMin) * i) / SAMPLES)),
    [exposure, claims, premium, xMin, xMax],
  );

  const yMax = Math.max(...samples.map((s) => Math.max(s.unhedged, s.hedged))) * 1.08 || 1;
  const yTicks = niceTicks(0, yMax, 3);
  const xTicks = niceTicks(xMin, xMax, 5);
  const here = at(scrub);
  const now = at(today);
  const saving = here.unhedged - here.hedged;
  const change: Change = {
    delta: here.hedged - here.unhedged,
    pct: here.unhedged !== 0 ? ((here.hedged - here.unhedged) / here.unhedged) * 100 : null,
    direction: Math.abs(saving) < 0.5 ? "flat" : saving > 0 ? "down" : "up",
  };

  const tablePrices = Array.from(new Set([xMin, L - (U - L) * 0.5, L, (L + U) / 2, U, U + (U - L) * 0.5, xMax, today].map((p) => Number(Math.max(p, 0).toFixed(4))))).sort((a, b) => a - b);

  const table = (
    <table className="table responsive">
      <thead><tr><th className="r">Settlement price</th><th className="r">Unhedged bill</th><th className="r">Claims pay</th><th className="r">Net bill, premium in</th></tr></thead>
      <tbody>
        {tablePrices.map((p) => {
          const s = at(p);
          return (
            <tr key={p}>
              <td className="r num" data-label="Settlement price">${trimmed(p, 2, 4)}{p === today ? " (today)" : ""}</td>
              <td className="r num" data-label="Unhedged">{usd0(s.unhedged)}</td>
              <td className="r num" data-label="Claims pay">{usd0(s.payout)}</td>
              <td className="r num" data-label="Net bill">{usd0(s.hedged)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <ChartShell
      label={`${label} $${trimmed(scrub, 2, 2)}`}
      value={usd0(here.hedged)}
      badge={<ChangeBadge change={change} format={usd0} suffix="vs unhedged" goodWhen="down" />}
      sub={<>Unhedged would be {usd0(here.unhedged)}; claims pay {usd0(here.payout)}. Move over the chart or use the slider.</>}
      surface={surface}
      source={
        <ul className="chart-keys" aria-label="Lines">
          <li><i style={{ background: "var(--chart-context)" }} aria-hidden />Unhedged bill</li>
          <li><i style={{ background: "var(--chart-accent)" }} aria-hidden />Hedged bill, premium included</li>
          <li><i className="band" aria-hidden />Hedge pays between ${trimmed(L, 2, 2)} and ${trimmed(U, 2, 2)}</li>
          <li><i className="live" aria-hidden />Pulsing dot: the live index, ${trimmed(today, 2, 4)}</li>
        </ul>
      }
      table={table}
      tableLabel="Table view: bill at sample prices"
    >
      <div style={{ height }} role="img" aria-label={`Monthly bill against settlement price. The hedged bill is flat between ${trimmed(L, 2, 2)} and ${trimmed(U, 2, 2)} dollars per GPU-hour and rises with the market above the cap.`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={samples}
            margin={{ top: 22, right: 4, bottom: 0, left: 0 }}
            onMouseMove={(state) => {
              const p = Number(state?.activeLabel);
              if (Number.isFinite(p)) onScrub(p);
            }}
          >
            <defs><FadeGradient id={gradient} color="var(--chart-accent)" top={0.2} /></defs>
            {yTicks.map((t) => <ReferenceLine key={t} y={t} stroke="var(--rule)" strokeWidth={1} ifOverflow="hidden" />)}
            <ReferenceArea x1={L} x2={U} fill="var(--chart-accent)" fillOpacity={0.06} stroke="none" ifOverflow="hidden" />
            <ReferenceLine x={U} stroke="var(--chart-accent)" strokeOpacity={0.5} strokeWidth={1} label={{ value: narrow ? "Cap" : `Cap $${trimmed(U, 2, 2)}`, position: "insideTopRight", fill: "var(--ink-2)", fontSize: 11, offset: 6 }} />
            <ReferenceLine x={L} stroke="var(--chart-accent)" strokeOpacity={0.5} strokeWidth={1} label={{ value: narrow ? "Floor" : `Floor $${trimmed(L, 2, 2)}`, position: "insideTopLeft", fill: "var(--ink-2)", fontSize: 11, offset: 6 }} />
            <XAxis
              dataKey="price"
              type="number"
              domain={[xMin, xMax]}
              ticks={xTicks}
              tickFormatter={(v: number) => `$${trimmed(v, 0, 2)}`}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--ink-3)", fontSize: 11 }}
              tickMargin={10}
              minTickGap={24}
            />
            <YAxis
              orientation="right"
              type="number"
              domain={[0, yMax]}
              ticks={yTicks}
              tickFormatter={compactUsd}
              tickLine={false}
              axisLine={false}
              width={52}
              tick={{ fill: "var(--ink-3)", fontSize: 11, textAnchor: "end", dx: 48 }}
            />
            <Tooltip cursor={false} content={<Tip />} isAnimationActive={false} offset={18} wrapperStyle={{ outline: "none", zIndex: 5 }} />
            <Line type="monotone" dataKey="unhedged" stroke="var(--chart-context)" strokeWidth={2} strokeLinecap="round" dot={false} activeDot={false} isAnimationActive={!reduce} animationDuration={350} />
            <Area type="monotone" dataKey="hedged" stroke="var(--chart-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" fill={`url(#${gradient})`} dot={false} activeDot={false} isAnimationActive={!reduce} animationDuration={350} />
            <ReferenceLine x={scrub} stroke="var(--rule-strong)" strokeWidth={1} ifOverflow="hidden" />
            <ReferenceDot x={scrub} y={here.unhedged} r={4} fill="var(--chart-context)" stroke="var(--chart-surface)" strokeWidth={2} ifOverflow="hidden" />
            <ReferenceDot x={scrub} y={here.hedged} r={4.5} fill="var(--chart-accent)" stroke="var(--chart-surface)" strokeWidth={2} ifOverflow="hidden" />
            <ReferenceDot x={today} y={now.hedged} ifOverflow="hidden" shape={<PulseDot color="var(--chart-accent)" still={Boolean(reduce)} />} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartShell>
  );
}
