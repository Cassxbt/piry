import { Area, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";
import type { Depth, DepthPoint } from "../../lib/depth";
import { FadeGradient, niceTicks, useGradientId } from "./parts";

interface Props {
  depth: Depth;
  symbol: string;
  quote: string;
  mark?: { price: number; label: string } | null;
  height?: number;
}

const size = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function Tip({ active, payload, symbol, quote }: { active?: boolean; payload?: { payload: DepthPoint }[]; symbol: string; quote: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p || (p.bid === null && p.ask === null)) return null;
  const isBid = p.bid !== null;
  return (
    <div className="chart-tip">
      <p className="chart-tip-time">{isBid ? "Bid" : "Ask"}, {isBid ? "selling down to" : "buying up to"}</p>
      <p className="chart-tip-value">{p.price.toFixed(4)}</p>
      <p className="chart-tip-row"><span>{isBid ? "You could sell" : "You could buy"}</span><b className="num">{size((isBid ? p.bid : p.ask) as number)} {symbol}</b></p>
      <p className="chart-tip-row"><span>{isBid ? "You would receive" : "You would pay"}</span><b className="num">{((isBid ? p.bidCost : p.askCost) as number).toFixed(2)} {quote}</b></p>
    </div>
  );
}

// Cumulative depth: the green area is what a seller can fill by selling down to a price, the rust area what a buyer can
// fill by paying up to one. Built from the resting levels the OrderBook contract returned, nothing interpolated.
export default function DepthChart({ depth, symbol, quote, mark, height = 170 }: Props) {
  const reduce = useReducedMotion();
  const bidGradient = useGradientId();
  const askGradient = `${bidGradient}a`;
  const yTicks = niceTicks(0, depth.maxSize * 1.05, 2);
  const xTicks = niceTicks(depth.xMin, depth.xMax, 4);
  const showMark = mark && mark.price >= depth.xMin && mark.price <= depth.xMax;

  return (
    <div style={{ height }} role="img" aria-label={`Cumulative depth of the ${symbol} book. The table below lists every level.`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={depth.points} margin={{ top: 14, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <FadeGradient id={bidGradient} color="var(--chart-accent)" top={0.3} />
            <FadeGradient id={askGradient} color="var(--chart-short)" top={0.3} />
          </defs>
          {yTicks.map((t) => <ReferenceLine key={t} y={t} stroke="var(--rule)" strokeWidth={1} ifOverflow="hidden" />)}
          <XAxis
            dataKey="price"
            type="number"
            domain={[depth.xMin, depth.xMax]}
            ticks={xTicks}
            tickFormatter={(v: number) => v.toFixed(2)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--ink-3)", fontSize: 11 }}
            tickMargin={8}
            minTickGap={20}
          />
          <YAxis
            orientation="right"
            type="number"
            domain={[0, depth.maxSize * 1.05]}
            ticks={yTicks}
            tickFormatter={size}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: "var(--ink-3)", fontSize: 11, textAnchor: "end", dx: 40 }}
          />
          {showMark ? (
            <ReferenceLine x={mark.price} stroke="var(--ink-3)" strokeOpacity={0.7} strokeWidth={1} label={{ value: mark.label, position: "insideTopRight", fill: "var(--ink-2)", fontSize: 11, offset: 6 }} />
          ) : null}
          <Tooltip cursor={{ stroke: "var(--rule-strong)", strokeWidth: 1 }} content={<Tip symbol={symbol} quote={quote} />} isAnimationActive={false} offset={14} wrapperStyle={{ outline: "none", zIndex: 5 }} />
          <Area type="stepBefore" dataKey="bid" stroke="var(--chart-accent)" strokeWidth={2} strokeLinejoin="round" fill={`url(#${bidGradient})`} dot={false} activeDot={{ r: 4, fill: "var(--chart-accent)", stroke: "var(--chart-surface)", strokeWidth: 2 }} connectNulls={false} isAnimationActive={!reduce} animationDuration={350} />
          <Area type="stepAfter" dataKey="ask" stroke="var(--chart-short)" strokeWidth={2} strokeLinejoin="round" fill={`url(#${askGradient})`} dot={false} activeDot={{ r: 4, fill: "var(--chart-short)", stroke: "var(--chart-surface)", strokeWidth: 2 }} connectNulls={false} isAnimationActive={!reduce} animationDuration={350} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
