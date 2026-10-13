import { useMemo } from "react";
import { H100_WEEKLY_ON_DEMAND, H100_WEEKLY_SOURCE } from "../data/h100Weekly";
import { liveSubject, useLiveSeries } from "../hooks/live";
import { studyHedge } from "../lib/hedgeStudy";
import { raw, trimmed } from "../lib/numbers";
import { SiteLink } from "./site/SiteLink";

const pct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const share = (v: number) => `${(v * 100).toFixed(0)}%`;

// Indicative backtest on weekly data. It exists to say plainly how much a snapshot-settled claim covers versus an
// average-settled one, not to forecast anything.
export function HedgeStudyNote() {
  const live = useLiveSeries();
  const L = live.band ? raw(live.band.lower, live.pd) : Number(liveSubject.series.source.bounds?.min ?? 2.5);
  const U = live.band ? raw(live.band.upper, live.pd) : 4.5;
  const study = useMemo(() => studyHedge(H100_WEEKLY_ON_DEMAND.map((r) => r.median), { lower: L, upper: U }), [L, U]);
  if (!study) return null;
  const first = H100_WEEKLY_ON_DEMAND[0]!.date;
  const last = H100_WEEKLY_ON_DEMAND[H100_WEEKLY_ON_DEMAND.length - 1]!.date;
  const weeksOutside = study.breaches.below + study.breaches.above;
  return (
    <div className="hedge-study">
      <dl className="cap-facts">
        <div><dt>H100 on-demand median, {study.weeks} weeks</dt><dd className="num">${trimmed(study.low, 2, 2)} to ${trimmed(study.high, 2, 2)}</dd></div>
        <div><dt>4-week change, middle 80% of windows</dt><dd className="num">{pct(study.change4w.p10)} to {pct(study.change4w.p90)}</dd></div>
        <div><dt>4-week change, extremes</dt><dd className="num">{pct(study.change4w.worst)} / {pct(study.change4w.best)}</dd></div>
        <div><dt>Weeks outside ${trimmed(L, 2, 2)} to ${trimmed(U, 2, 2)}</dt><dd className="num">{weeksOutside} of {study.weeks}{study.breaches.below > 0 ? ` (${study.breaches.below} below the floor, ${study.breaches.above} above the cap)` : ""}</dd></div>
        <div><dt>Month-average bill variance removed, snapshot claim</dt><dd className="num">{share(study.varianceRemoved.snapshot)}</dd></div>
        <div><dt>Same, average-price (TWAP) claim</dt><dd className="num">{share(study.varianceRemoved.average)}</dd></div>
      </dl>
      <p className="sub">
        Method and assumptions: weekly medians from {first} to {last} stand in for the hourly rate. For each rolling four-week window the bill is the average of the four weekly medians; a snapshot claim settles on the last of them, an average claim on their average. One claim per GPU-hour of band width, payoffs linear, premium treated as a constant, and no basis between the index and a team&rsquo;s own invoice. Weekly data understates intra-week moves, and 53 weeks is one regime, so read this as indicative.
      </p>
      <p className="callout">
        <strong>Conclusion.</strong> In this window the price stayed close to the band, so a claim settled on a single snapshot removed most of the month-average bill variance ({share(study.varianceRemoved.snapshot)}), and an average-settled one would have removed nearly all of it ({share(study.varianceRemoved.average)}). The gap is the cost of timing: the snapshot can land on a spike or a dip that the month did not have. Average-price (TWAP) series are on the <SiteLink to="/roadmap" className="text-link">roadmap</SiteLink> for that reason.
      </p>
      <p className="sub">
        Data: <a href={H100_WEEKLY_SOURCE.url} target="_blank" rel="noreferrer">{H100_WEEKLY_SOURCE.name}</a>, {H100_WEEKLY_SOURCE.license}, credit GetDeploying, fetched {H100_WEEKLY_SOURCE.fetched}. Used here for context only; it never feeds settlement.
      </p>
    </div>
  );
}
