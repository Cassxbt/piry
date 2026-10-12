import { BandRuler, type RulerMarker } from "../components/BandRuler";
import { PendingInline } from "../components/Pending";
import { Src } from "../components/Src";
import { chain, config } from "../config";
import { useChainNow, useMark, useMarket } from "../hooks/chain";
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

function SeriesCard() {
  const market = useMarket();
  const mark = useMark();
  const snapshot = market.data;
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const delivery = config.settlementMode ? DELIVERY[config.settlementMode] : null;
  const phase = snapshot ? phaseLabel(phaseOf(snapshot)) : null;

  const unit = (raw: bigint, digits = 2) => usd(raw, snapshot?.terms.priceDecimals ?? 6, digits);
  const markers: RulerMarker[] = [];
  if (snapshot) {
    const price = 10 ** snapshot.terms.priceDecimals;
    if (snapshot.state.settled) {
      markers.push({ value: Number(snapshot.state.settlementPrice) / price, label: `settled ${unit(snapshot.state.settlementPrice, 4)}`, tone: "long" });
    } else if (mark.data?.status === "ok" && mark.data.indexPrice !== null) {
      markers.push({ value: Number(mark.data.indexPrice) / price, label: `index ${unit(mark.data.indexPrice, 4)}`, tone: "ink" });
    }
  }

  const sanity = config.series.source.sanityBand;
  if (snapshot && config.series.dataMode === "LIVE" && sanity?.value) {
    markers.push({ value: Number(sanity.value), label: `${sanity.name.split(" ")[0]} ref $${sanity.value}`, tone: "short" });
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
                    <span className="sub">Intended live index: {config.series.source.name}. {config.series.source.summary}</span>
                  </>
                ) : (
                  <span className="sub">Source: {config.series.source.name}. {config.series.source.summary}</span>
                )}
                {config.series.source.sanityBand ? (
                  <span className="sub">
                    Sanity band: {config.series.source.sanityBand.name} ({config.series.source.sanityBand.license}), not used for settlement.
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
                  <BandRuler
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
                    <span className="mark-big">{markLabel(mark.data.answer, mark.data.decimals, mark.data.isFinal ? 6 : 4)}</span>
                    <span className="sub">per whole long claim</span>
                  </div>
                  <span className="sub num">
                    {mark.data.isFinal
                      ? "Final value: the market has settled."
                      : mark.data.indexPrice !== null && snapshot
                        ? `Index observed ${unit(mark.data.indexPrice)}, round ${mark.data.roundId.toString()}, ${duration(Number((now ?? mark.data.updatedAt) - mark.data.updatedAt))} ago`
                        : null}
                  </span>
                  {config.markStaleSeconds > 0 && !mark.data.isFinal && now !== null && now - mark.data.updatedAt > BigInt(config.markStaleSeconds) ? (
                    <span className="chip warn">Stale: no update for over {duration(config.markStaleSeconds)}</span>
                  ) : null}
                  <Src contract="PiryMarkFeed" address={config.contracts.markFeed} block={mark.data.block} />
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

export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="content">
        <div className="hero-eyebrow rise">
          <span className="chip plain">{chain.name}</span>
          <span className="sub">Prototype. Not audited. Test funds only.</span>
        </div>
        <h1 className="hero-title rise">
          <span>Hourly GPU prices float.</span>
          <span>Your customer contracts don&rsquo;t.</span>
          <span>
            <em>Piry caps the gap.</em>
          </span>
        </h1>
        <p className="hero-lede rise d1">
          If you rent GPUs by the hour and sell at a fixed price, a jump in H100 rates comes straight out of your margin. Piry issues fully collateralized claims on a GPU rental price index.
          Buy the long side on Kuru&rsquo;s order book and it pays out as the index rises, up to a cap you can see before you trade.
        </p>
        <div className="hero-actions rise d1">
          <a className="btn" href="#exposure">Size your hedge</a>
          <a className="btn secondary" href="#evidence">See settlement evidence</a>
        </div>
        <p className="hero-disclaimer rise d1">
          Cash-settled claims on a price index. Not insurance, no guarantee of reimbursement, and no compute is reserved or delivered.
        </p>

        <div className="hero-grid">
          <SeriesCard />
          <div className="rise d3">
            <p className="label" style={{ marginBottom: 12 }}>Why a hedge, and why now</p>
            <ul className="whynow">
              <li>
                <span className="fig">CME</span>
                <p>
                  <strong>Delayed.</strong> CME&rsquo;s GPU rental futures were delayed when the CFTC extended its review, citing &ldquo;novel or complex issues.&rdquo;
                </p>
              </li>
              <li>
                <span className="fig">ICE</span>
                <p>
                  <strong>Specs published.</strong> ICE and Ornn have published contract specifications for GPU rental pricing.
                </p>
              </li>
              <li>
                <span className="fig">~85%</span>
                <p>
                  <strong>Volatile.</strong> H100 realized volatility has reached about 85%.
                </p>
              </li>
              <li>
                <span className="fig">~$570k</span>
                <p>
                  <strong>Demand exists.</strong> Polymarket&rsquo;s H100 rental-price markets have traded up to ~$570k on a single market, and Kalshi lists GPU rental contracts. Those are binary bets that pay all or nothing.
                  Piry&rsquo;s payout scales with the price move inside the band.
                </p>
              </li>
            </ul>
            <p className="label" style={{ margin: "32px 0 0" }}>How a claim works</p>
            <ol className="how">
              <li>
                <span className="n">01</span>
                <div>
                  <h4>Mint</h4>
                  <p>One unit of dollar collateral mints one long and one short claim, both ordinary ERC-20 tokens. Every claim is fully backed.</p>
                </div>
              </li>
              <li>
                <span className="n">02</span>
                <div>
                  <h4>Settle</h4>
                  <p>When the period ends, a Chainlink CRE report publishes the index price. Long redeems the share of the band the price has climbed, short redeems the rest.</p>
                </div>
              </li>
              <li>
                <span className="n">03</span>
                <div>
                  <h4>Trade and exit</h4>
                  <p>Hedgers buy long on Kuru&rsquo;s order book; GPU owners and lenders take the short. A matched pair can always be merged back into collateral.</p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </header>
  );
}
