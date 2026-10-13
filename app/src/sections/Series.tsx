import BandGauge, { type GaugeMarker } from "../components/charts/BandGauge";
import { Section } from "../components/Section";
import { PendingInline } from "../components/Pending";
import { Src } from "../components/Src";
import { config, primarySubject } from "../config";
import { useChainNow, useMark, useMarket, useSeriesShortMark } from "../hooks/chain";
import { MarkHistoryChart } from "../components/charts/lazy";
import { duration, fixed, usd, utc } from "../lib/format";
import { DELIVERY, markLabel, phaseLabel } from "../lib/labels";
import { phaseOf, type MarketSnapshot } from "../lib/reads";

const CONTRACT_NAMES: Record<string, string> = {
  market: "ComputeMarket",
  longClaim: "Long claim (PIRY-L)",
  shortClaim: "Short claim (PIRY-S)",
  collateral: "Collateral token",
  settlementReceiver: "Settlement receiver",
  markFeed: "PiryMarkFeed",
  shortFeed: "PiryShortFeed",
  forwarder: "Forwarder",
};

function periodLine(s: MarketSnapshot, now: bigint | null): string {
  const phase = phaseOf(s);
  const t = now ?? s.block.timestamp;
  if (phase === "pre-period") return `Starts in ${duration(Number(s.terms.periodStart - t))}`;
  if (phase === "in-period") return `Ends in ${duration(Number(s.terms.periodEnd - t))}`;
  if (phase === "settled" || phase === "settled-fallback") return "Period ended and settled";
  return `Ended ${duration(Number(t - s.terms.periodEnd))} ago`;
}

export function SeriesCard() {
  const shortMark = useSeriesShortMark(primarySubject);
  const market = useMarket();
  const mark = useMark();
  const snapshot = market.data;
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const delivery = config.settlementMode ? DELIVERY[config.settlementMode] : null;
  const phase = snapshot ? phaseLabel(phaseOf(snapshot)) : null;

  const unit = (raw: bigint, digits = 2) => usd(raw, snapshot?.terms.priceDecimals ?? 6, digits);
  const markers: GaugeMarker[] = [];
  if (snapshot) {
    const price = 10 ** snapshot.terms.priceDecimals;
    if (snapshot.state.settled) {
      markers.push({ value: Number(snapshot.state.settlementPrice) / price, label: `settled ${unit(snapshot.state.settlementPrice, 4)}`, tone: "accent" });
    } else if (mark.data?.status === "ok" && mark.data.indexPrice !== null) {
      markers.push({ value: Number(mark.data.indexPrice) / price, label: `index ${unit(mark.data.indexPrice, 4)}`, tone: "accent" });
    }
  }

  return (
    <div className="panel rise d2">
      <div className="panel-head">
        <span className="label">Live series · {config.series.name}</span>
        {snapshot && phase ? (
          <span className={`chip ${phase.tone}`}>{phase.text}</span>
        ) : market.isError ? (
          <span className="chip bad">RPC error</span>
        ) : config.contracts.market ? (
          <span className="chip plain">Reading chain</span>
        ) : (
          <span className="chip plain">Not deployed</span>
        )}
      </div>
      <div className="panel-pad stack">
        {!config.contracts.market ? (
          <div className="pending" role="status">
            <strong>Series deployment pending</strong>
            <span className="sub">
              No market is configured for {config.chain.name}. Terms, band, mark and collateral appear here as soon as <span className="mono">deployments/{config.network}.json</span> lists a
              completed deployment. Nothing on this card is placeholder data.
            </span>
          </div>
        ) : market.isError ? (
          <div className="pending" role="alert">
            <strong>Could not read the market</strong>
            <span className="sub">{market.error instanceof Error ? market.error.message : String(market.error)}</span>
          </div>
        ) : null}

        <dl className="kv">
          <div>
            <dt>Index</dt>
            <dd>
              <div className="stack" style={{ gap: 4 }}>
                <span>{config.series.hardware}, {config.series.units}</span>
                {config.series.dataMode === "DEMO" ? (
                  <>
                    <span className="chip warn plain">Synthetic demo data on this deployment</span>
                    <span className="sub">{config.series.source.demo ?? "No real price source is attached."}</span>
                    <span className="sub">Intended live index: {config.series.source.name}.</span>
                  </>
                ) : (
                  <span className="sub">Index: {config.series.source.name}.</span>
                )}
                {config.series.source.minValid !== null ? (
                  <span className="sub">
                    {config.series.source.components.length} public sources; a reading needs at least {config.series.source.minValid} valid. Source table in the evidence step.
                  </span>
                ) : null}
                {config.series.source.sanityBand ? (
                  <span className="sub">
                    Sanity band: {config.series.source.sanityBand.name}
                    {config.series.source.sanityBand.value ? `, $${config.series.source.sanityBand.value}` : ""}
                    {config.series.source.sanityBand.asOf ? `, ${config.series.source.sanityBand.asOf}` : ""} ({config.series.source.sanityBand.license}), not used for settlement.
                  </span>
                ) : null}
              </div>
            </dd>
          </div>

          <div>
            <dt>Payout band</dt>
            <dd>
              {snapshot ? (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="num">
                    {unit(snapshot.terms.lower)} to {unit(snapshot.terms.upper)} per GPU-hour
                  </span>
                  <BandGauge
                    lower={Number(snapshot.terms.lower) / 10 ** snapshot.terms.priceDecimals}
                    upper={Number(snapshot.terms.upper) / 10 ** snapshot.terms.priceDecimals}
                    markers={markers}
                    money={(v) => `$${v.toFixed(v % 1 === 0 ? 0 : 2)}`}
                    ariaLabel={`Payout band ${unit(snapshot.terms.lower)} to ${unit(snapshot.terms.upper)}`}
                  />
                  <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
                </div>
              ) : (
                <PendingInline>Awaiting deployment</PendingInline>
              )}
            </dd>
          </div>

          <div>
            <dt>Current mark</dt>
            <dd>
              {mark.data?.status === "ok" ? (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
                    <span className="mark-big">{markLabel(mark.data.answer, mark.data.decimals, 6)}</span>
                    <span className="sub">per whole long claim</span>
                  </div>
                  {shortMark.data?.status === "ok" ? (
                    <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
                      <span className="num" style={{ fontSize: 17 }}>{markLabel(shortMark.data.answer, shortMark.data.decimals, 6)}</span>
                      <span className="sub">per whole short claim, 1 minus the long value (PiryShortFeed)</span>
                    </div>
                  ) : null}
                  <span className="sub num">
                    {mark.data.isFinal
                      ? "Final value: the market has settled."
                      : mark.data.indexPrice !== null && snapshot
                        ? `Index observed ${unit(mark.data.indexPrice, 4)}, round ${mark.data.roundId.toString()}, ${duration(Number((now ?? mark.data.updatedAt) - mark.data.updatedAt))} ago`
                        : null}
                  </span>
                  {config.markStaleSeconds > 0 && !mark.data.isFinal && now !== null && now - mark.data.updatedAt > BigInt(config.markStaleSeconds) ? (
                    <span className="chip warn">Stale: no update for over {duration(config.markStaleSeconds)}</span>
                  ) : null}
                  <Src contract="PiryMarkFeed" address={config.contracts.markFeed} block={mark.data.block} />
                  {shortMark.data?.status === "ok" ? <Src contract="PiryShortFeed" address={config.contracts.shortFeed} block={shortMark.data.block} /> : null}
                </div>
              ) : mark.data?.status === "empty" ? (
                <div className="stack" style={{ gap: 4 }}>
                  <PendingInline>No mark published yet</PendingInline>
                  <span className="sub">The feed reverts with NoData until its first CRE update.</span>
                </div>
              ) : mark.data?.status === "error" ? (
                <PendingInline>Feed unreadable</PendingInline>
              ) : (
                <PendingInline>{config.contracts.markFeed ? "Reading feed" : "No feed deployed"}</PendingInline>
              )}
            </dd>
          </div>

          <div>
            <dt>Period</dt>
            <dd>
              {snapshot ? (
                <div className="stack" style={{ gap: 2 }}>
                  <span className="num">
                    {utc(snapshot.terms.periodStart)}
                    <br />
                    to {utc(snapshot.terms.periodEnd)}
                  </span>
                  <span className="sub">{periodLine(snapshot, now)}</span>
                  {!snapshot.state.settled && now !== null && now < snapshot.terms.periodEnd ? (
                    <div className="countdown" role="timer" aria-label="Time to the period end">
                      <span className="label">Settlement snapshot in</span>
                      <span className="num">{duration(Number(snapshot.terms.periodEnd - now))}</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <PendingInline>Awaiting deployment</PendingInline>
              )}
            </dd>
          </div>

          <div>
            <dt>Collateral</dt>
            <dd>
              {snapshot ? (
                <div className="stack" style={{ gap: 2 }}>
                  <span>
                    {snapshot.collateral.symbol}: 1 {snapshot.collateral.symbol} mints 1 long + 1 short claim
                  </span>
                  <span className="num">{fixed(snapshot.state.collateralLocked, snapshot.collateral.decimals)} {snapshot.collateral.symbol} locked</span>
                  <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
                </div>
              ) : (
                <PendingInline>Awaiting deployment</PendingInline>
              )}
            </dd>
          </div>

          <div>
            <dt>Settlement</dt>
            <dd>
              <div className="stack" style={{ gap: 4 }}>
                <span>{config.settlement.source}</span>
                {delivery ? (
                  <>
                    <span className="chip warn plain">{delivery.short}</span>
                    <span className="sub">{delivery.detail}</span>
                  </>
                ) : (
                  <PendingInline>Delivery mode pending</PendingInline>
                )}
                {snapshot ? (
                  <span className="sub">
                    If no valid report arrives within {duration(Number(snapshot.terms.fallbackDelay))} of period end, anyone can settle at the band midpoint ({unit((snapshot.terms.lower + snapshot.terms.upper) / 2n)}). Funds can never be locked.
                  </span>
                ) : null}
              </div>
            </dd>
          </div>
        </dl>

        {Object.keys(config.deployed).length > 0 ? (
          <details className="contracts">
            <summary>Contracts on {config.chain.name}</summary>
            <ul>
              {Object.entries(config.deployed).map(([key, c]) => (
                <li key={key}>
                  <span>
                    {CONTRACT_NAMES[key] ?? key}
                    {c.mock ? " (mock)" : ""}
                  </span>
                  <Src contract={key === "market" ? "ComputeMarket" : key} address={c.address} block={c.blockNumber} />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function SeriesSection() {
  return (
    <Section
      id="series"
      index="1/6"
      kicker="The series"
      title={
        <>
          The series you are <em>trading</em>
        </>
      }
      lede="One deployed market: its band, its period, its collateral and the mark every exchange price comes from. Everything here is read from the chain."
    >
      <div className="series-grid">
        <SeriesCard />
        <div className="stack">
          <p className="label">How a claim works</p>
          <ol className="how">
            <li>
              <span className="n">01</span>
              <div>
                <h3>Mint</h3>
                <p>One unit of dollar collateral mints one long and one short claim, both ordinary ERC-20 tokens. Every claim is fully backed.</p>
              </div>
            </li>
            <li>
              <span className="n">02</span>
              <div>
                <h3>Settle</h3>
                <p>When the period ends, a report from the CRE workflow (run through the CRE CLI simulation today; on a DON with consensus in production) publishes the index price. Long redeems the share of the band the price has climbed, short redeems the rest.</p>
              </div>
            </li>
            <li>
              <span className="n">03</span>
              <div>
                <h3>Trade and exit</h3>
                <p>Hedgers buy long on Kuru&rsquo;s order book; GPU owners and lenders take the short. A matched pair can always be merged back into collateral.</p>
              </div>
            </li>
          </ol>
        </div>
      </div>
      <div className="chart-card chart-card--spaced">
        <MarkHistoryChart subject={primarySubject} surface="sheet" />
      </div>
    </Section>
  );
}
