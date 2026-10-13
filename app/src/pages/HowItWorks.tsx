import { useEffect, useMemo, useRef, useState } from "react";
import { ForwardLock } from "../components/live/ForwardLock";
import { TimingNote } from "../components/live/TimingNote";
import { GlossaryLine } from "../components/site/Term";
import { Stage } from "../components/stages/Stages";
import { BlockHead } from "../components/site/Frame";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { Pending } from "../components/Pending";
import { Src } from "../components/Src";
import { config } from "../config";
import { hedgeBasisNote, useExampleSize, useHedgeQuote } from "../hooks/hedgeQuote";
import { liveSubject, useLiveSeries } from "../hooks/live";
import { useMedia } from "../hooks/useMedia";
import { usePage } from "../hooks/usePage";
import { claimsToHold, lockedMonthlyBill, maxPayout, outcomeAt, type Exposure } from "../lib/hedge";
import { duration, fixed, usd, utc } from "../lib/format";
import { MARK_CADENCE } from "../lib/labels";
import { raw, trimmed } from "../lib/numbers";

const STEPS = [
  {
    title: "Mint a pair",
    text: "Deposit one unit of dollar collateral and receive one long and one short claim. Both are ordinary ERC-20 tokens, and the contract keeps the collateral, so every claim is fully backed. A pair can always be merged back into the collateral it came from.",
    link: { to: "/app", hash: "trade", label: "Mint a pair in the app" },
  },
  {
    title: "Buy the long on Kuru",
    text: "A hedger buys long claims on Kuru's on-chain order book. A GPU owner or lender mints a pair, sells the long into that book and keeps the short. Orders and fills are on-chain. Kuru's order book prices the claim; the PiryMarkFeed is the custody price source Kuru uses to value deposits and withdrawals.",
    link: { to: "/built-on", hash: "kuru", label: "How Kuru fits" },
  },
  {
    title: "The index moves",
    text: `A Chainlink CRE workflow reads four public H100 prices, takes the median and publishes a mark (${MARK_CADENCE}): the feed's value for one long claim, (index - floor) / (cap - floor), always between $0 and $1. The workflow is run today through the CRE CLI simulation (one node) by our keeper; production runs the same workflow on a DON with consensus. The mark is what Kuru's custody reads; trading prices come from the order book.`,
    link: { to: "/index", hash: undefined, label: "The composite index" },
  },
  {
    title: "CRE settles",
    text: "Settlement fixes the price from the first valid workflow run after the period ends. The snapshot is taken when that run executes, up to 24 hours after the period end (workflow configuration); the keeper insists on all four sources for the first 4 hours. The contract's separate 6-hour limit is the report's age at delivery, not how long after the period end it may be taken. The market accepts one report, only if it matches the chain, index, spec and period. Stale, replayed, wrong-chain and wrong-sender reports are refused, and the ones found on-chain are on the ledger. If no valid report arrives within seven days, anyone can settle at the band midpoint.",
    link: { to: "/evidence", hash: undefined, label: "The refusal ledger" },
  },
  {
    title: "Redeem",
    text: "Burn your claims and receive collateral: the long gets the share of the band the index climbed, the short gets the rest. Preview the amount first and set a minimum payout, so the transaction reverts if it is not what you expect. Merging a pair is exact; redeeming the two legs separately rounds each payout down, so a matched pair can leave a unit of dust.",
    link: { to: "/app", hash: "redeem", label: "Redeem in the app" },
  },
] as const;

function Explainer() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const wide = useMedia("(min-width: 980px)");

  useEffect(() => {
    if (!wide) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-42% 0px -42% 0px", threshold: 0 },
    );
    refs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [wide]);

  return (
    <div className="explainer">
      {wide ? (
        <div className="explainer-stage">
          <div className="explainer-sticky"><Stage step={active} /></div>
        </div>
      ) : null}
      <ol className="explainer-steps">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            data-step={i}
            data-active={wide ? i === active : undefined}
            ref={(el) => { refs.current[i] = el; }}
            className="ex-step"
          >
            {!wide ? <div className="ex-inline"><Stage step={i} /></div> : null}
            <p className="ex-num mono">{String(i + 1).padStart(2, "0")} / 05</p>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
            <SiteLink to={s.link.to} hash={s.link.hash} className="text-link">{s.link.label}</SiteLink>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WorkedExample() {
  const live = useLiveSeries();
  const claimToken = live.market?.claims.long;
  const example = useExampleSize(live.band && live.market ? { band: live.band, priceDecimals: live.pd, collateralDecimals: live.market.collateral.decimals } : null, claimToken);
  const model = useMemo(() => {
    if (!live.market || !live.band || live.index === null || live.long === null) return null;
    const exposure: Exposure = { gpus: example.gpus, hours: example.hours, band: live.band, priceDecimals: live.pd, collateralDecimals: live.market.collateral.decimals };
    const claims = claimsToHold(exposure);
    return { exposure, claims };
  }, [live.market, live.band, live.index, live.long, live.pd, example.gpus, example.hours]);
  const feedMark = useMemo(() => (live.long !== null ? { value: live.long, scale: live.longScale } : null), [live.long, live.longScale]);
  const quote = useHedgeQuote(model ? model.claims : null, feedMark, live.market?.collateral.decimals ?? 6, "long", claimToken);

  if (!model || !quote || !live.market || !live.band || live.index === null || live.long === null) {
    return <Pending title="Waiting for the live series">The worked example uses the live band and the feed&rsquo;s current mark.</Pending>;
  }
  const cd = live.market.collateral.decimals;
  const L = raw(live.band.lower, live.pd);
  const U = raw(live.band.upper, live.pd);
  const W = U - L;
  const today = raw(live.index, live.pd);
  const money = (v: bigint) => usd(v, cd, 0);
  const premium = quote.premium;
  const scenarios = [
    { key: "below", title: "Below the floor", price: Math.max(0.01, L - W * 0.5), note: "The long pays nothing. You keep the cheaper GPUs and lose the premium." },
    { key: "today", title: "Where it stands today", price: today, note: "Inside the band, so a rise from here is paid back by the claims." },
    { key: "above", title: "Above the cap", price: U + W * 0.5, note: "The claims have paid their maximum. Each further dollar comes out of your pocket." },
  ];
  return (
    <div className="worked">
      <ol className="worked-math">
        <li>
          <span className="mono">1</span>
          <p>Your exposure: <strong>{example.gpus.toString()} GPUs for {example.hours.toString()} hours</strong> a month is <strong>{(example.gpus * example.hours).toLocaleString("en-US")} GPU-hours</strong>. This is an example input, sized to what the long book can fill in full right now; the app takes yours.</p>
        </li>
        <li>
          <span className="mono">2</span>
          <p>The live band runs from <strong>${trimmed(L, 2, 2)}</strong> to <strong>${trimmed(U, 2, 2)}</strong>, so it is <strong>${trimmed(W, 2, 2)}</strong> wide. Hedge size is GPU-hours of exposure x band width: {(example.gpus * example.hours).toLocaleString("en-US")} x ${trimmed(W, 2, 2)} = <strong>{fixed(model.claims, live.market.claims.decimals, 0)} claims</strong>, each paying up to $1.</p>
        </li>
        <li>
          <span className="mono">3</span>
          <p>The index stands at <strong>${trimmed(today, 4, 6)}</strong>, so one long claim is worth ({trimmed(today, 4, 6)} - {trimmed(L, 2, 2)}) / {trimmed(W, 2, 2)} = <strong>${trimmed(Number(live.long) / Number(live.longScale), 4, 6)}</strong> (the feed&rsquo;s mark). Buying {fixed(model.claims, live.market.claims.decimals, 0)} claims costs about <strong>{money(premium)}</strong>. {hedgeBasisNote(quote, live.market.claims.decimals)}</p>
        </li>
        <li>
          <span className="mono">4</span>
          <p>Between the floor and the cap the hedge holds the modelled bill, re-priced at the settlement-day rate, at about <strong>{money(lockedMonthlyBill(model.exposure) + premium)}</strong>: your GPU-hours at the floor, plus the premium. That level can sit above or below today&rsquo;s bill; the note under the cards shows by how much. The most the claims can ever pay is <strong>{money(maxPayout(model.claims))}</strong>.</p>
        </li>
      </ol>
      <div className="scenarios scenarios--cards">
        {scenarios.map((s) => {
          const o = outcomeAt(model.exposure, model.claims, premium, BigInt(Math.round(s.price * 10 ** live.pd)));
          return (
            <div key={s.key} className="scenario">
              <h4>{s.title}</h4>
              <p className="num">index ${trimmed(s.price, 2, 4)}</p>
              <dl className="num">
                <div><dt>unhedged bill</dt><dd>{money(o.unhedged)}</dd></div>
                <div><dt>claims pay</dt><dd>{money(o.payout)}</dd></div>
                <div><dt>net bill</dt><dd><strong>{money(o.hedged)}</strong></dd></div>
              </dl>
              <p className="sub">{s.note}</p>
            </div>
          );
        })}
      </div>
      <ForwardLock exposure={model.exposure} claims={model.claims} premium={premium} today={today} />
      <Src contract="ComputeMarket, PiryMarkFeed" address={liveSubject.contracts.market} block={live.market.block.number} />
    </div>
  );
}

function Fallback() {
  const live = useLiveSeries();
  const t = live.market?.terms;
  return (
    <div className="fallback brackets">
      <div>
        <p className="mono fb-tag">SAFETY VALVE</p>
        <h3>A silent oracle holds payouts for a grace period, then a fallback can settle</h3>
        <p>
          Until the market settles, a holder of a single leg cannot redeem it (a matched pair can still be merged). If no valid report arrives within {t ? duration(Number(t.fallbackDelay)) : "seven days"} of the period end, anyone can call the fallback and settle at the band midpoint
          {t ? `, ${usd((t.lower + t.upper) / 2n, live.pd, 2)} here` : ""}. The first settlement wins: a valid report that is ready can lose the race to the fallback. The midpoint is a fixed split of the band, not a recovery of the fair price, and it can favour a holder who would have been paid less. That gives a holder on the losing side of the index a reason to stay silent until the fallback opens; the incentive is disclosed here, not removed. The fallback has its own event, <span className="mono">SettledByFallback</span>, and its own label on the evidence page, so it never passes for an oracle report. A settled market also pays out a holder who only ever held one leg.
        </p>
        {t ? <p className="sub num">The window opens {utc(t.periodEnd + t.fallbackDelay)}.</p> : null}
      </div>
    </div>
  );
}

export default function HowItWorks() {
  const live = useLiveSeries();
  usePage("How it works", "Mint a pair, buy the long on Kuru, watch the index move, let Chainlink CRE settle it, and redeem. A worked example with the live band and the cap made honest.");
  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="How it works"
            title={<>Five steps from a GPU bill to <em>a capped hedge</em></>}
            lede="Scroll through the life of a claim. The pictures use the live series and the settled fast demo; anything that is only an illustration says so."
          />
          <GlossaryLine />
        </div>
      </header>

      <section className="block block--flush" aria-label="Step by step">
        <div className="wrap"><Explainer /></div>
      </section>

      <section className="block" aria-labelledby="worked-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Worked example" index="A" title={<>Real numbers, <em>live band</em></>} lede={`The band and the mark are read from ${config.chain.name} right now. Only the GPU count and hours are an example, sized to what the long book can fill in full right now.`} id="worked-title" />
          </Reveal>
          <Reveal delay={0.05}><WorkedExample /></Reveal>
          <TimingNote periodEnd={live.market?.terms.periodEnd} />
        </div>
      </section>

      <section className="block" aria-labelledby="cap-honest-title">
        <div className="wrap">
          <Reveal>
            <BlockHead
              kicker="The cap, made honest"
              index="B"
              title={<>What a Piry hedge does <em>not</em> do</>}
              id="cap-honest-title"
            />
          </Reveal>
          <ul className="honest-list">
            {[
              ["It is capped.", "Above the cap the claims pay nothing more. Every extra dollar of GPU price is unhedged, and the chart above shows exactly where that starts."],
              ["It costs a premium.", "If prices fall, you keep the cheaper GPUs but lose what you paid for the claims. A hedge that cannot lose money would not be a hedge."],
              ["It hedges a price, not an invoice.", "The claims settle against an index of public prices. Your own provider's bill can differ from it, and nothing is reimbursed."],
              ["It settles on one snapshot.", "The index is a snapshot of catalogue prices taken when settlement executes, not an average of your month. It does not lock a monthly compute bill."],
              ["It cannot be liquidated.", "Claims are fully collateralized, with no margin and no liquidation. The most you can lose is the premium you paid."],
            ].map(([head, body], i) => (
              <li key={head}>
                <Reveal delay={i * 0.05}>
                  <strong>{head}</strong>
                  <span>{body}</span>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="block" aria-labelledby="fallback-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Failure mode" index="C" title={<>If the oracle goes quiet, <em>a fallback settles it after seven days</em></>} id="fallback-title" />
          </Reveal>
          <Reveal delay={0.05}><Fallback /></Reveal>
        </div>
      </section>

      <section className="cta-band">
        <div className="wrap cta-inner">
          <div>
            <h2 className="block-title">Try it on the live series</h2>
            <p className="lede">Size a hedge with your own numbers, or read the refusals first.</p>
          </div>
          <div className="cta-actions">
            <SiteLink to="/app" hash="exposure" className="btn">Size your hedge</SiteLink>
            <SiteLink to="/evidence" className="btn secondary">Read the evidence</SiteLink>
          </div>
        </div>
      </section>
    </>
  );
}
