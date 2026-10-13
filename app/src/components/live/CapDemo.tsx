import { useMemo, useState } from "react";
import { liveSubject, useLiveSeries } from "../../hooks/live";
import { chartDomain, claimsToHold, lockedMonthlyBill, maxPayout, outcomeAt, regimeOf, type Exposure } from "../../lib/hedge";
import { fixed, usd } from "../../lib/format";
import { raw, trimmed } from "../../lib/numbers";
import { ScenarioChart } from "../charts/lazy";
import { Pending } from "../Pending";
import { Src } from "../Src";

const GPUS = 64n;
const HOURS = 720n;

// The cap, drawn honestly: an example team (64 GPUs, 720 hours) against the live series' real band, priced at the
// feed's long mark. It is an example input, not a quote; the app page has the full calculator.
export function CapDemo() {
  const live = useLiveSeries();
  const [scrub, setScrub] = useState<number | null>(null);
  const model = useMemo(() => {
    if (!live.market || !live.band || live.index === null || live.long === null) return null;
    const exposure: Exposure = { gpus: GPUS, hours: HOURS, band: live.band, priceDecimals: live.pd, collateralDecimals: live.market.collateral.decimals };
    const claims = claimsToHold(exposure);
    const premium = (claims * live.long) / live.longScale;
    return { exposure, claims, premium };
  }, [live.market, live.band, live.index, live.long, live.longScale, live.pd]);

  if (!model || !live.market || !live.band || live.index === null) {
    return <Pending title="Waiting for the live series">The cap chart needs the band and the current index from the chain.</Pending>;
  }
  const cd = live.market.collateral.decimals;
  const L = raw(live.band.lower, live.pd);
  const U = raw(live.band.upper, live.pd);
  const today = raw(live.index, live.pd);
  const domain = chartDomain(L, U, today);
  const at = scrub ?? today;
  const o = outcomeAt(model.exposure, model.claims, model.premium, BigInt(Math.round(at * 10 ** live.pd)));
  const regime = regimeOf(BigInt(Math.round(at * 10 ** live.pd)), live.band);
  const money = (v: bigint) => usd(v, cd, 0);

  return (
    <div className="cap-demo">
      <div className="cap-chart">
        <ScenarioChart surface="sheet" exposure={model.exposure} claims={model.claims} premium={model.premium} today={today} scrub={at} domain={domain} onScrub={setScrub} />
        <label className="sr-only" htmlFor="cap-scrub">Settlement price scenario</label>
        <input id="cap-scrub" type="range" min={domain[0]} max={domain[1]} step={(domain[1] - domain[0]) / 400} value={at} onChange={(e) => setScrub(Number(e.target.value))} />
        <p className="cap-readout num" aria-live="polite">
          If the index settles at <strong>${trimmed(at, 2, 2)}</strong> ({regime === "in-band" ? "inside the band" : regime === "below" ? "below the floor" : "above the cap"}): unhedged {money(o.unhedged)}, claims pay {money(o.payout)}, net {money(o.hedged)}.
        </p>
      </div>
      <dl className="cap-facts">
        <div><dt>Example team</dt><dd>{GPUS.toString()} GPUs, {HOURS.toString()} hours a month = {(GPUS * HOURS).toLocaleString("en-US")} GPU-hours</dd></div>
        <div><dt>Claims to hold</dt><dd className="num">{fixed(model.claims, live.market.claims.decimals, 0)}</dd></div>
        <div><dt>Cost at the feed mark</dt><dd className="num">{money(model.premium)}</dd></div>
        <div><dt>Maximum payout</dt><dd className="num">{money(maxPayout(model.claims))}</dd></div>
        <div><dt>Bill held between ${trimmed(L, 2, 2)} and ${trimmed(U, 2, 2)}</dt><dd className="num">{money(lockedMonthlyBill(model.exposure) + model.premium)}</dd></div>
      </dl>
      <p className="sub">
        Hedge size = GPU-hours of exposure x band width: {(GPUS * HOURS).toLocaleString("en-US")} x ${trimmed(U - L, 2, 2)} = {fixed(model.claims, live.market.claims.decimals, 0)} claims, each paying up to $1. Priced at the feed&rsquo;s long mark, not a Kuru quote.
      </p>
      <Src contract="ComputeMarket" address={liveSubject.contracts.market} block={live.market.block.number} />
    </div>
  );
}
