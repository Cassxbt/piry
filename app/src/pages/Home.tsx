import { JudgeAccess } from "../components/JudgeAccess";
import { TimingNote } from "../components/live/TimingNote";
import { Term } from "../components/site/Term";
import { CapDemo } from "../components/live/CapDemo";
import { TractionTile } from "../components/live/TractionPanel";
import { IndexRange } from "../components/live/IndexRange";
import { LivePanel } from "../components/live/LivePanel";
import { MarkHistoryChart } from "../components/charts/lazy";
import { ProofStrip } from "../components/live/ProofStrip";
import { liveSubject } from "../hooks/live";
import { BlockHead, Kicker } from "../components/site/Frame";
import { Cites } from "../components/site/Cites";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { config } from "../config";
import { links } from "../config/links";
import { whyNow } from "../content/whyNow";
import { useLiveSeries } from "../hooks/live";
import { usePage } from "../hooks/usePage";
import { usd, utc } from "../lib/format";
import { MARK_CADENCE } from "../lib/labels";
import { trimmed, raw } from "../lib/numbers";

function HeroFacts() {
  const live = useLiveSeries();
  const L = live.band ? raw(live.band.lower, live.pd) : null;
  const U = live.band ? raw(live.band.upper, live.pd) : null;
  return (
    <dl className="hero-facts rise d3">
      <div><dt><Term k="band">Band</Term></dt><dd className="num">{L !== null && U !== null ? `$${trimmed(L, 2, 2)} to $${trimmed(U, 2, 2)}` : "n/a"}</dd></div>
      <div><dt>Index now</dt><dd className="num">{live.index !== null ? `$${trimmed(raw(live.index, live.pd), 4, 4)}` : "n/a"}</dd></div>
      <div><dt>Settles</dt><dd className="num">{live.market ? utc(live.market.terms.periodEnd) : "n/a"}</dd></div>
    </dl>
  );
}

function Hero() {
  return (
    <header className="home-hero">
      <div className="wrap home-hero-grid">
        <div className="home-hero-copy">
          <Kicker>GPU price claims on Monad</Kicker>
          <h1 className="hero-title rise">
            <span>Hourly GPU prices float.</span>
            <span>Your customer contracts don&rsquo;t.</span>
            <span><em>Piry caps the gap.</em></span>
          </h1>
          <p className="hero-lede rise d1">
            Piry lets GPU renters and providers trade fully backed, capped exposure to an H100 rental-price index on Monad, with transparent settlement evidence. A renter buys a capped long <Term k="claim" /> on Kuru: if the index settles above the floor, the claim pays the difference, up to a cap you can see before you trade.
          </p>
          <div className="hero-actions rise d2">
            <SiteLink to="/app" hash="exposure" className="btn">Size your hedge</SiteLink>
            <SiteLink to="/how-it-works" className="btn secondary">How it works</SiteLink>
          </div>
          <p className="hero-disclaimer rise d2">
            Cash-settled claims on a price index. Not insurance, no guarantee of reimbursement, and no compute is reserved or delivered.
          </p>
          <HeroFacts />
        </div>
        <div className="home-hero-panel rise d1">
          <LivePanel />
        </div>
      </div>
    </header>
  );
}

function Steps() {
  const live = useLiveSeries();
  const L = live.band ? raw(live.band.lower, live.pd) : null;
  const U = live.band ? raw(live.band.upper, live.pd) : null;
  const kuruListed = config.kuru.longMarket !== null || config.kuru.shortMarket !== null;
  const steps = [
    {
      n: "1/3",
      title: "Hedge",
      text: "If you rent GPUs by the hour, buy long claims sized to your GPU-hours. If the index settles between the floor and the cap, every dollar it has risen above the floor is paid back to you.",
      fact: L !== null && U !== null ? `Live band: $${trimmed(L, 2, 2)} to $${trimmed(U, 2, 2)} per GPU-hour` : "Live band: awaiting the chain",
      to: "/app",
      hash: "exposure",
      cta: "Size a hedge",
    },
    {
      n: "2/3",
      title: "Trade on Kuru",
      text: "Claims are plain ERC-20 tokens that trade on Kuru's on-chain order book. Hedgers buy the long; GPU owners and lenders take the short. Anyone can also mint a pair from collateral.",
      fact: kuruListed ? "Kuru market: listed" : "Kuru market: listing pending",
      to: "/app",
      hash: "trade",
      cta: "See the trade step",
    },
    {
      n: "3/3",
      title: "Settle with Chainlink",
      text: <>After the period ends, the first valid run of a Chainlink <Term k="CRE" /> workflow reads four public price sources, takes the median and reports it on-chain. The snapshot is taken when that run executes, up to 24 hours after the period end (the keeper insists on all four sources for the first 4 hours). Today the workflow runs through the CRE CLI simulation (one node), driven by our keeper ({MARK_CADENCE}); production would run the same workflow on a DON with consensus. If no report is delivered, anyone can settle at the band midpoint after 7 days. Long and short are paid from the same collateral, and refused reports found on-chain are listed on the evidence page.</>,
      fact: live.market ? `Next settlement: ${utc(live.market.terms.periodEnd)}` : "Next settlement: awaiting the chain",
      to: "/evidence",
      hash: undefined,
      cta: "See the evidence",
    },
  ];
  return (
    <ol className="steps3">
      {steps.map((s, i) => (
        <li key={s.title}>
          <Reveal delay={i * 0.07} className="step-card brackets">
            <p className="step-count mono">{s.n}</p>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
            <p className="step-fact mono">{s.fact}</p>
            <SiteLink to={s.to} hash={s.hash} className="text-link">{s.cta}</SiteLink>
          </Reveal>
        </li>
      ))}
    </ol>
  );
}

function WhyNow() {
  return (
    <ul className="whynow whynow-wide">
      {whyNow.map((item, i) => (
        <li key={item.fig}>
          <Reveal delay={i * 0.05}>
            <span className="fig">{item.fig}</span>
            <div>
              <p><strong>{item.headline}</strong> {item.text}</p>
              <Cites sources={item.sources} />
            </div>
          </Reveal>
        </li>
      ))}
    </ul>
  );
}

function Audience() {
  return (
    <div className="audience-grid">
      <Reveal className="aud brackets">
        <p className="mono aud-tag">LONG</p>
        <h3>Inference startups with fixed-price plans</h3>
        <p>You sell at a fixed price and buy GPU hours at the spot rate. A long claim pays when the rate rises, so a spike no longer eats the margin you promised customers.</p>
      </Reveal>
      <Reveal delay={0.07} className="aud brackets">
        <p className="mono aud-tag">SHORT</p>
        <h3>GPU owners and lenders</h3>
        <p>Your income and your collateral are worth less when rental rates fall. A short claim pays out as the index falls, so you buy it as the hedge. Whoever sells it is paid up front and takes the other side of the index.</p>
      </Reveal>
    </div>
  );
}

export default function Home() {
  usePage("Piry", "Piry lets GPU renters and providers trade fully backed, capped exposure to an H100 rental-price index on Monad, with transparent settlement evidence. Claims trade on Kuru and are settled by Chainlink CRE.");
  const live = useLiveSeries();
  return (
    <>
      <Hero />

      <section className="block block--tight" aria-labelledby="judges-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="For judges" index="00" title={<>Try it in <em>two minutes</em></>} id="judges-title" />
          </Reveal>
          <Reveal delay={0.05}><JudgeAccess /></Reveal>
        </div>
      </section>

      <section className="block block--tight" aria-labelledby="proof-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Proof, not promises" index="01" title={<>Live on Monad testnet, <em>with the receipts</em></>} id="proof-title" />
          </Reveal>
          <Reveal delay={0.05}><ProofStrip /></Reveal>
          <Reveal delay={0.08} className="chart-card"><MarkHistoryChart subject={liveSubject} surface="sheet" /></Reveal>
          <Reveal delay={0.1}><IndexRange /></Reveal>
          <Reveal delay={0.12}>
            <p className="mono traction-kicker">TRACTION ON KURU</p>
            <TractionTile />
            <p className="block-link"><SiteLink to="/evidence" className="text-link">Full breakdown, team versus unclassified</SiteLink></p>
          </Reveal>
        </div>
      </section>

      <section className="block" aria-labelledby="steps-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Three steps" index="02" title={<>Hedge it, trade it, <em>settle it</em></>} lede="One contract holds the collateral. Everything else is a token you can hold, sell or redeem." id="steps-title" />
          </Reveal>
          <Steps />
        </div>
      </section>

      <section className="block" aria-labelledby="cap-title">
        <div className="wrap">
          <Reveal>
            <BlockHead
              kicker="The cap, made visible"
              index="03"
              title={<>See exactly where <em>the hedge stops</em></>}
              lede="Drag the settlement price. Inside the band the modelled bill stays flat. Below the floor you keep the saving and lose the premium. Above the cap every extra dollar is unhedged."
              id="cap-title"
            />
          </Reveal>
          <Reveal delay={0.05}><CapDemo /></Reveal>
          <TimingNote periodEnd={live.market?.terms.periodEnd} />
          <p className="block-link">
            <SiteLink to="/app" hash="exposure" className="text-link">Run it with your own GPUs</SiteLink>
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="why-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Why now" index="04" title={<>Interest is visible, <em>and the exchange products are not live</em></>} lede="Exchange products for GPU rental prices are under review or pending approval, and the prediction markets that do exist pay all or nothing. Every line below links to its source." id="why-title" />
          </Reveal>
          <WhyNow />
        </div>
      </section>

      <section className="block" aria-labelledby="who-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Two sides" index="05" title={<>One claim for the renter, <em>one for the owner</em></>} id="who-title" />
          </Reveal>
          <Audience />
          <p className="block-link"><SiteLink to="/market" className="text-link">Who the first users are, and how Piry differs from perps</SiteLink></p>
        </div>
      </section>

      <section className="block block--tight" aria-labelledby="built-by-title">
        <div className="wrap">
          <Reveal className="built-by">
            <p className="mono kicker-line"><i className="sq" aria-hidden />BUILT BY</p>
            <h2 className="sr-only" id="built-by-title">Built by cassxbt</h2>
            <p>Built by <strong>cassxbt</strong> — a solo full-stack and Solidity engineer. A perps trader who has been liquidated on positions that were right a week later, and who pays a floating GPU bill every month: Piry is the hedge its builder wanted.</p>
            <p className="block-link">
              <SiteLink to="/about" className="text-link">Why a trader built Piry</SiteLink>
              <a className="text-link" href={links.x} target="_blank" rel="noreferrer">X @cassxbt</a>
              <a className="text-link" href={links.github} target="_blank" rel="noreferrer">GitHub</a>
            </p>
          </Reveal>
        </div>
      </section>

      <section className="cta-band" aria-labelledby="cta-title">
        <div className="wrap cta-inner">
          <div>
            <p className="mono cta-kicker"><i className="sq" aria-hidden />LIVE SERIES</p>
            <h2 id="cta-title" className="block-title">
              {live.market ? <>Settles {utc(live.market.terms.periodEnd)}.</> : <>Open the app.</>} <em>Watch it happen.</em>
            </h2>
            <p className="lede">
              {live.index !== null ? `The index stands at ${usd(live.index, live.pd, 4)} against a band of ${live.band ? `${usd(live.band.lower, live.pd, 2)} to ${usd(live.band.upper, live.pd, 2)}` : "n/a"}. ` : ""}
              Mint a pair, size a hedge, and follow the report that settles it, on {config.chain.name}.
            </p>
          </div>
          <div className="cta-actions">
            <SiteLink to="/app" className="btn">Open the app</SiteLink>
            <SiteLink to="/evidence" className="btn secondary">Read the evidence</SiteLink>
          </div>
        </div>
      </section>
    </>
  );
}
