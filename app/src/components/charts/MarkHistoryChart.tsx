import { useMemo, useState } from "react";
import { Area, AreaChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";
import { explorer } from "../../config";
import type { SeriesSubject } from "../../config/types";
import { useChainNow, useSeriesMarket } from "../../hooks/chain";
import { useFeedHistory } from "../../hooks/feedHistory";
import { changeOver, RANGES, windowPoints, type FeedPoint, type RangeId } from "../../lib/feedHistory";
import { blockLabel, shortHash, utc } from "../../lib/format";
import { trimmed } from "../../lib/numbers";
import { Src } from "../Src";
import { ChangeBadge, ChartShell, Pills } from "./ChartShell";
import { FadeGradient, niceTicks, paddedDomain, PulseDot, useGradientId } from "./parts";

type SeriesId = "index" | "long" | "short";

const SERIES: Record<SeriesId, { label: string; unit: string; color: string; value: (p: FeedPoint) => number; fmt: (n: number) => string; clamp?: [number, number]; goodWhen: "up" | "down" }> = {
  index: { label: "Composite index", unit: "USD per GPU-hour", color: "var(--chart-accent)", value: (p) => p.index, fmt: (n) => `$${trimmed(n, 4, 6)}`, goodWhen: "up" },
  long: { label: "Long claim value", unit: "USD per PIRY-L", color: "var(--chart-accent)", value: (p) => p.long, fmt: (n) => `$${trimmed(n, 4, 6)}`, clamp: [0, 1], goodWhen: "up" },
  short: { label: "Short claim value", unit: "USD per PIRY-S, 1 minus the long value", color: "var(--chart-short)", value: (p) => p.short, fmt: (n) => `$${trimmed(n, 4, 6)}`, clamp: [0, 1], goodWhen: "up" },
};

const clock = (t: number, span: number) => {
  const d = new Date(t * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (span <= 86400) return hm;
  return span <= 4 * 86400 ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

interface TipProps {
  active?: boolean;
  payload?: { payload: FeedPoint }[];
  fmt: (n: number) => string;
  value: (p: FeedPoint) => number;
}

function Tip({ active, payload, fmt, value }: TipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chart-tip">
      <p className="chart-tip-time">{utc(p.t, true)}</p>
      <p className="chart-tip-value">{fmt(value(p))}</p>
      <p className="chart-tip-meta">
        {p.final ? "Final value, market settled" : p.held ? "Held until the next round" : `Round ${p.round.toString()}`}
        {p.block !== null ? ` · block ${blockLabel(p.block)}` : ""}
      </p>
    </div>
  );
}

interface Props {
  subject: SeriesSubject;
  initial?: SeriesId;
  height?: number;
  surface?: "paper" | "sheet";
}

// Feed-round history as a single step line with a soft fade: the index is held until the next round, so it is drawn as
// a step. Every point is a round in PiryMarkFeed's own state (rounds(i)); block and transaction come from MarkUpdated.
export default function MarkHistoryChart({ subject, initial = "index", height = 280, surface = "paper" }: Props) {
  const reduce = useReducedMotion();
  const gradient = useGradientId();
  const history = useFeedHistory(subject);
  const marketQuery = useSeriesMarket(subject);
  const now = useChainNow(marketQuery.data, marketQuery.dataUpdatedAt);
  const [seriesId, setSeriesId] = useState<SeriesId>(initial);
  const [range, setRange] = useState<RangeId>("ALL");
  const [showSources, setShowSources] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const spec = SERIES[seriesId];
  const hasShort = subject.contracts.shortFeed !== null;
  const sources = subject.series.source.components.filter((c) => c.value !== null);

  const all = history.data?.points ?? [];
  const nowSeconds = now !== null ? Number(now) : all.length ? (all[all.length - 1] as FeedPoint).t : 0;
  const view = useMemo(() => windowPoints(all, range, nowSeconds), [all, range, nowSeconds]);
  const values = view.points.map(spec.value);
  const sourceValues = showSources && seriesId === "index" ? sources.map((s) => Number(s.value)) : [];
  const [yMin, yMax] = values.length ? paddedDomain([...values, ...sourceValues], spec.clamp, seriesId === "index" ? Math.max(...values) * 0.06 : 0.1) : [0, 1];
  const yTicks = niceTicks(yMin, yMax, 3);
  const span = view.end - view.start;
  const xTicks = niceTicks(view.start, view.end, 4);
  const last = view.points.at(-1);
  const real = view.points.filter((p) => !p.held);
  const change = changeOver(values);
  const feedAddress = subject.contracts.markFeed;

  const tabs = (
    <Pills
      label="Series"
      value={seriesId}
      onChange={setSeriesId}
      options={[
        { id: "index", label: "Index" },
        { id: "long", label: "Long" },
        ...(hasShort ? [{ id: "short" as const, label: "Short" }] : []),
      ]}
    />
  );

  if (history.isLoading || marketQuery.isLoading) {
    return <ChartShell label={spec.label} value="n/a" sub="Reading feed rounds" tabs={tabs} surface={surface}><div className="chart-empty" style={{ height }}>Reading the feed</div></ChartShell>;
  }
  if (history.isError) {
    return (
      <ChartShell label={spec.label} value="n/a" sub="The feed rounds could not be read" tabs={tabs} surface={surface}>
        <div className="chart-empty" style={{ height }}>The RPC did not answer. Nothing is plotted rather than an estimate; the chart retries on its own.</div>
      </ChartShell>
    );
  }
  if (!feedAddress || all.length === 0 || !last) {
    return (
      <ChartShell label={spec.label} value="n/a" sub="No round has been published yet" tabs={tabs} surface={surface}>
        <div className="chart-empty" style={{ height }}>The feed reverts with NoData until its first CRE update, so there is nothing to plot.</div>
      </ChartShell>
    );
  }

  const table = (
    <table className="table responsive">
      <thead><tr><th>Round</th><th>Observed (UTC)</th><th className="r">Index</th><th className="r">Long</th><th className="r">Short</th><th>Block</th><th>Evidence</th></tr></thead>
      <tbody>
        {[...real].reverse().map((p) => (
          <tr key={`${p.round}-${p.final}`}>
            <td className="num" data-label="Round">{p.final ? "final" : p.round.toString()}</td>
            <td className="num" data-label="Observed">{utc(p.t, true)}</td>
            <td className="r num" data-label="Index">{p.final ? "settled" : `$${trimmed(p.index, 4, 6)}`}</td>
            <td className="r num" data-label="Long">${trimmed(p.long, 4, 8)}</td>
            <td className="r num" data-label="Short">${trimmed(p.short, 4, 8)}</td>
            <td className="num" data-label="Block">
              {p.block !== null && p.tx ? (explorer.tx(p.tx) ? <a href={explorer.tx(p.tx) as string} target="_blank" rel="noreferrer">{blockLabel(p.block)}</a> : blockLabel(p.block)) : <span className="sub">n/a</span>}
            </td>
            <td className="mono" data-label="Evidence">{p.evidenceHash ? shortHash(p.evidenceHash) : "n/a"}</td>
          </tr>
        ))}
        {showSources && seriesId === "index" ? sources.map((s) => (
          <tr key={s.name}><td data-label="Round">source</td><td data-label="Observed">{subject.series.source.componentsAsOf ?? "recorded"}</td><td className="r num" data-label="Index">${s.value}</td><td data-label="Long" /><td data-label="Short" /><td data-label="Block" /><td data-label="Evidence">{s.name}</td></tr>
        )) : null}
      </tbody>
    </table>
  );

  return (
    <ChartShell
      label={`${spec.label}, ${spec.unit}`}
      tabs={tabs}
      value={spec.fmt(spec.value(last))}
      badge={<ChangeBadge change={change} format={(n) => (seriesId === "index" ? `$${trimmed(n, 2, 4)}` : `$${trimmed(n, 2, 6)}`)} suffix={range === "ALL" ? "since the first round" : `over ${range}`} goodWhen={spec.goodWhen} />}
      sub={
        <>
          {real.length} round{real.length === 1 ? "" : "s"} in view. Held until the next round
          {seriesId === "short" ? "; short = 1 minus long, the PiryShortFeed rule" : ""}.
        </>
      }
      surface={surface}
      pills={<Pills label="Time range" value={range} onChange={setRange} options={RANGES.map((r) => ({ id: r.id, label: r.label }))} />}
      source={
        <>
          {sources.length > 0 && seriesId === "index" ? (
            <button type="button" className="chart-toggle" aria-pressed={showSources} onClick={() => setShowSources((v) => !v)}>
              {showSources ? "Hide sources" : "Show sources"}
            </button>
          ) : null}
          <Src contract="PiryMarkFeed" address={feedAddress} block={marketQuery.data?.block.number ?? null} />
        </>
      }
      table={table}
    >
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={view.points} margin={{ top: 14, right: 4, bottom: 0, left: 0 }}>
            <defs><FadeGradient id={gradient} color={spec.color} /></defs>
            {yTicks.map((t) => <ReferenceLine key={t} y={t} stroke="var(--rule)" strokeWidth={1} ifOverflow="hidden" />)}
            <XAxis
              dataKey="t"
              type="number"
              domain={[view.start, view.end]}
              ticks={xTicks}
              tickFormatter={(t: number) => clock(t, span)}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--ink-3)", fontSize: 11 }}
              tickMargin={10}
              minTickGap={32}
            />
            <YAxis
              orientation="right"
              type="number"
              domain={[yMin, yMax]}
              ticks={yTicks}
              tickFormatter={(v: number) => (seriesId === "index" ? `$${trimmed(v, 2, 2)}` : `$${trimmed(v, 2, 3)}`)}
              tickLine={false}
              axisLine={false}
              width={48}
              tick={{ fill: "var(--ink-3)", fontSize: 11, textAnchor: "end", dx: 44 }}
            />
            {showSources && seriesId === "index"
              ? sources.map((s) => (
                  <ReferenceLine
                    key={s.name}
                    y={Number(s.value)}
                    stroke="var(--chart-context)"
                    strokeOpacity={focus === null ? 0.55 : focus === s.name ? 0.95 : 0.12}
                    strokeWidth={focus === s.name ? 1.5 : 1}
                    label={focus === s.name ? { value: `${s.name} $${s.value}`, position: "insideTopLeft", fill: "var(--ink-2)", fontSize: 11 } : undefined}
                  />
                ))
              : null}
            <Tooltip
              cursor={{ stroke: "var(--rule-strong)", strokeWidth: 1 }}
              content={<Tip fmt={spec.fmt} value={spec.value} />}
              isAnimationActive={false}
              offset={16}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ outline: "none", zIndex: 5 }}
            />
            <Area
              type="stepAfter"
              dataKey={(p: FeedPoint) => spec.value(p)}
              stroke={spec.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={`url(#${gradient})`}
              dot={false}
              activeDot={{ r: 4.5, fill: spec.color, stroke: "var(--chart-surface)", strokeWidth: 2 }}
              isAnimationActive={!reduce}
              animationDuration={450}
              animationEasing="ease-out"
            />
            <ReferenceDot x={last.t} y={spec.value(last)} ifOverflow="extendDomain" shape={<PulseDot color={spec.color} still={Boolean(reduce)} />} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {showSources && seriesId === "index" ? (
        <ul className="chart-legend" aria-label="Sources behind the index">
          {sources.map((s) => (
            <li key={s.name}>
              <button type="button" onMouseEnter={() => setFocus(s.name)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(s.name)} onBlur={() => setFocus(null)}>
                <i aria-hidden />
                <span>{s.name}</span>
                <span className="num">${s.value}</span>
              </button>
            </li>
          ))}
          <li className="chart-legend-note">Recorded at {subject.series.source.componentsAsOf ?? "deployment"}; the index is their median.</li>
        </ul>
      ) : null}
    </ChartShell>
  );
}
