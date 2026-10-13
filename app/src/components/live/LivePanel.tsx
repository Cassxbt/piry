import { Term } from "../site/Term";
import { useMemo } from "react";
import { config } from "../../config";
import { useSeriesShortMark } from "../../hooks/chain";
import { liveSubject, useLiveSeries } from "../../hooks/live";
import { blockLabel } from "../../lib/format";
import { markLabel } from "../../lib/labels";
import { raw, trimmed } from "../../lib/numbers";
import { summarizeSources } from "../../lib/indexSources";
import BandGauge, { type GaugeMarker } from "../charts/BandGauge";
import { Src } from "../Src";
import { CountUp } from "../site/motion";
import { Frame } from "../site/Frame";

const price = (n: number) => `$${trimmed(n, 2, 4)}`;

// The home-page product frame: the four public sources scroll through, a CRE report pulse carries them to the
// composite, and the composite sets the long claim's value on the band. Everything shown is from config or the chain.
export function LivePanel() {
  const live = useLiveSeries();
  const shortMark = useSeriesShortMark(liveSubject).data;
  const { series } = liveSubject;
  const components = series.source.components;
  const summary = summarizeSources(components, series.source.minValid);
  const rows = useMemo(() => components.filter((c) => c.value !== null), [components]);
  const index = live.index !== null ? raw(live.index, live.pd) : null;
  const longValue = live.long !== null ? Number(live.long) / Number(live.longScale) : null;
  const lower = live.band ? raw(live.band.lower, live.pd) : null;
  const upper = live.band ? raw(live.band.upper, live.pd) : null;
  const markers: GaugeMarker[] = index !== null ? [{ value: index, label: `index ${price(index)}`, tone: "accent" }] : [];
  const status = live.mark?.status === "ok" ? `feed round ${live.mark.roundId.toString()}` : live.indexOrigin === "recorded" ? "recorded sources" : "awaiting data";

  const sourceRow = (c: (typeof rows)[number], i: number, hidden: boolean) => (
    <li className="lp-row" style={{ ["--i" as string]: i }} key={`${c.name}${hidden ? "-b" : ""}`}>
      <span className="lp-name">
        {c.name}
        {c.detail ? <small>{c.detail}</small> : null}
      </span>
      <span className="lp-val num">${c.value}</span>
      <span className="lp-status"><i className="dot" aria-hidden />{c.status === "valid" ? "valid" : c.status}</span>
    </li>
  );

  return (
    <div className="live-panel brackets">
      <Frame
        title="Piry H100 composite"
        count="1/4"
        status={
          <span className="live-chip">
            <i className="dot" aria-hidden />
            {live.market ? `block ${blockLabel(live.market.block.number)}` : "connecting"}
          </span>
        }
        label="Live index panel: four public sources feed a composite that prices the long claim"
      >
        <div className="lp-body">
          <div className="lp-block">
            <p className="lp-label"><i className="sq" aria-hidden />Sources, H100 SXM 1 GPU on demand<span>{rows.length} public</span></p>
            <div className="lp-window" aria-hidden>
              <ul className="lp-scroll">
                {rows.map((c, i) => sourceRow(c, i, false))}
                {rows.map((c, i) => sourceRow(c, i, true))}
              </ul>
            </div>
            <ul className="sr-only">
              {rows.map((c) => <li key={c.name}>{c.name}: ${c.value}, {c.status}</li>)}
            </ul>
          </div>

          <div className="lp-wire" aria-hidden><span>CRE report</span></div>

          <div className="lp-block lp-composite">
            <p className="lp-label"><i className="sq" aria-hidden />Composite, median of valid sources<span>2/4</span></p>
            <div className="lp-big">
              <CountUp value={index} format={(n) => `$${trimmed(n, 4, 6)}`} className="num lp-number" />
              <span className="lp-note">
                {summary.valid} of {summary.total} valid{series.source.minValid !== null ? `, needs ${series.source.minValid}` : ""}
              </span>
            </div>
            {lower !== null && upper !== null ? (
              <div className="lp-gauge">
                <BandGauge lower={lower} upper={upper} markers={markers} money={(v) => `$${trimmed(v, 2, 2)}`} ariaLabel={`Payout band ${price(lower)} to ${price(upper)}`} />
              </div>
            ) : null}
          </div>

          <div className="lp-wire" aria-hidden><span>sets</span></div>

          <div className="lp-block">
            <p className="lp-label"><i className="sq" aria-hidden />Long claim value, PIRY-L<span>3/4</span></p>
            <div className="lp-big">
              <CountUp value={longValue} format={(n) => `$${trimmed(n, 4, 6)}`} className="num lp-number" />
              <span className="lp-note">per claim, pays $1 at the cap</span>
            </div>
            {shortMark?.status === "ok" ? (
              <p className="lp-short">
                <span>Short, PIRY-S</span>
                <b className="num">${trimmed(Number(shortMark.answer) / 10 ** shortMark.decimals, 4, 8)}</b>
                <small>1 minus the long value, PiryShortFeed</small>
              </p>
            ) : null}
          </div>
        </div>
        <footer className="frame-foot">
          <span>
            {live.mark?.status === "ok" && live.mark.isFinal ? "Final value, market settled." : null}
            Sources {series.source.componentsAsOf ? `recorded at ${series.source.componentsAsOf}` : "recorded"}; composite and claim value read from {status}.
          </span>
          <span className="frame-srcs">
            {live.market ? <Src contract="PiryMarkFeed" address={liveSubject.contracts.markFeed} block={live.mark?.status === "ok" ? live.mark.block : live.market.block.number} /> : null}
            {shortMark?.status === "ok" ? <Src contract="PiryShortFeed" address={liveSubject.contracts.shortFeed} block={shortMark.block} /> : null}
          </span>
        </footer>
      </Frame>
      <p className="panel-caption">
        {config.series.dataMode === "LIVE" ? "Real public prices, delivered to the chain by the CRE CLI in simulation (one node)." : "Demo data."} <Term k="mark">Mark</Term> shown: {live.mark?.status === "ok" ? markLabel(live.mark.answer, live.mark.decimals, 6) : "n/a"}.
      </p>
    </div>
  );
}
