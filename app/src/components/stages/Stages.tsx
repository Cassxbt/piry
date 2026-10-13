import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useState } from "react";
import { config } from "../../config";
import { useKuruBook } from "../../hooks/kuru";
import { useMarkRounds } from "../../hooks/ledger";
import { useLifecycle } from "../../hooks/lifecycle";
import { demoSubject, useLiveSeries, useSeries } from "../../hooks/live";
import { fixed, usd } from "../../lib/format";
import { payouts } from "../../lib/payout";
import { priceText } from "../../lib/kuruMath";
import { raw, trimmed } from "../../lib/numbers";
import BandGauge from "../charts/BandGauge";
import { Src } from "../Src";
import { Frame } from "../site/Frame";
import { EASE_OUT } from "../site/motion";

const TITLES = ["Mint a pair", "Buy the long on Kuru", "The index moves", "CRE settles", "Redeem"] as const;

function Tile({ tone, title, line, delay = 0 }: { tone: "long" | "short" | "plain"; title: string; line: string; delay?: number }) {
  return (
    <div className={`tile tile--${tone}`} style={{ animationDelay: `${delay}ms` }}>
      <span className="tile-title mono">{title}</span>
      <span className="tile-line">{line}</span>
    </div>
  );
}

function StageMint() {
  const live = useLiveSeries();
  const cd = live.market?.collateral.decimals ?? 6;
  return (
    <div className="stage-body stage-mint">
      <Tile tone="plain" title="1.00 collateral" line={live.market ? `${live.market.collateral.symbol}, you deposit` : "dollar collateral"} />
      <span className="arrow" aria-hidden />
      <Tile tone="plain" title="ComputeMarket" line={live.market ? `holds ${fixed(live.market.state.collateralLocked, cd)} ${live.market.collateral.symbol} right now` : "the vault"} delay={120} />
      <span className="arrow" aria-hidden />
      <div className="tile-pair">
        <Tile tone="long" title={`1.00 ${live.market?.claims.longSymbol ?? "PIRY-L"}`} line="long: pays more as the index rises" delay={240} />
        <Tile tone="short" title={`1.00 ${live.market?.claims.shortSymbol ?? "PIRY-S"}`} line="short: pays more as it falls" delay={320} />
      </div>
      <p className="stage-note">A pair always merges back into exactly the collateral it was minted from, so the two legs together are always worth 1.00.</p>
      {live.market ? <Src contract="ComputeMarket" address={live.subject.contracts.market} block={live.market.block.number} /> : null}
    </div>
  );
}

function StageTrade() {
  const book = useKuruBook("long");
  const listed = config.kuru.longMarket !== null || config.kuru.shortMarket !== null;
  const bid = book.data?.bids[0];
  const ask = book.data?.asks[0];
  return (
    <div className="stage-body stage-trade">
      <Tile tone="long" title="Hedger" line="rents GPUs by the hour; buys the long" />
      <span className="arrow arrow--both" aria-hidden />
      <div className="tile tile--book">
        <span className="tile-title mono">Kuru order book</span>
        <span className="tile-line">PIRY-L / {config.kuru.quoteSymbol}, on-chain</span>
        {listed && book.data ? (
          <span className="book-line num">
            bid {bid ? priceText(bid.priceRaw, book.data.scale) : "none"} · ask {ask ? priceText(ask.priceRaw, book.data.scale) : "none"}
          </span>
        ) : (
          <span className="chip warn plain">Kuru listing pending</span>
        )}
      </div>
      <span className="arrow arrow--both" aria-hidden />
      <Tile tone="short" title="GPU owner or lender" line="mints a pair, sells the long, keeps the short" />
      <p className="stage-note">
        The PiryMarkFeed exists so Kuru can price the claim: it reports the long claim&rsquo;s value in dollars, the way an exchange expects a price source to.
      </p>
    </div>
  );
}

function StageIndex() {
  const live = useLiveSeries();
  const [hypo, setHypo] = useState<number | null>(null);
  const rounds = useMarkRounds(live.subject, live.mark?.status === "ok" ? (live.mark.isFinal ? live.mark.roundId - 1n : live.mark.roundId) : undefined);
  if (!live.band || live.index === null) return <div className="stage-body"><p className="stage-note">Waiting for the live series.</p></div>;
  const L = raw(live.band.lower, live.pd);
  const U = raw(live.band.upper, live.pd);
  const idx = hypo ?? raw(live.index, live.pd);
  const longValue = Math.min(1, Math.max(0, (idx - L) / (U - L)));
  return (
    <div className="stage-body stage-index">
      <BandGauge lower={L} upper={U} markers={[{ value: idx, label: hypo === null ? `index $${trimmed(idx, 2, 4)}` : `what if $${trimmed(idx, 2, 2)}`, tone: "accent" }]} money={(v) => `$${trimmed(v, 2, 2)}`} ariaLabel={`Payout band $${L} to $${U}`} />
      <label className="sr-only" htmlFor="what-if">Try a different index price</label>
      <input id="what-if" type="range" min={Math.max(0, L - (U - L) * 0.3)} max={U + (U - L) * 0.3} step={0.005} value={idx} onChange={(e) => setHypo(Number(e.target.value))} />
      <div className="split-row num" aria-live="polite">
        <span><small>LONG</small>${trimmed(longValue, 4, 5)}</span>
        <span><small>SHORT</small>${trimmed(1 - longValue, 4, 5)}</span>
        <span><small>{hypo === null ? "LIVE" : "WHAT-IF"}</small>{hypo === null ? "from the feed" : <button type="button" className="text-btn" onClick={() => setHypo(null)}>reset</button>}</span>
      </div>
      <p className="stage-note">
        A CRE workflow (run today through the CRE CLI simulation by our keeper) checks the mark every 5 minutes, publishing when the index moves and at least every 20 minutes. {rounds.data?.length ? `${rounds.data.length} round${rounds.data.length > 1 ? "s" : ""} on-chain so far.` : "No rounds yet."} Long = (index - floor) / (cap - floor), clamped to $0 to $1.
      </p>
    </div>
  );
}

const SOURCES = ["Akash", "RunPod", "Verda", "Shadeform"] as const;
const REFUSALS = ["stale report", "replayed report", "wrong chain", "wrong sender", "before period end", "duplicate slot"] as const;

function StageSettle() {
  return (
    <div className="stage-body stage-settle">
      <div className="flow">
        <div className="flow-col">
          {SOURCES.map((s, i) => <span className="flow-chip" key={s} style={{ animationDelay: `${i * 90}ms` }}>{s}</span>)}
        </div>
        <span className="arrow" aria-hidden />
        <Tile tone="plain" title="CRE workflow" line="reads 4 sources, median, at least 3 valid" delay={380} />
        <span className="arrow" aria-hidden />
        <Tile tone="plain" title="Receiver" line="checks the sender, then calls the market" delay={460} />
        <span className="arrow" aria-hidden />
        <Tile tone="long" title="settle()" line="once, bound to chain, index, spec and period" delay={540} />
      </div>
      <div className="refusals">
        <p className="mono refusals-label">Refused on the record</p>
        <ul>
          {REFUSALS.map((r, i) => <li key={r} style={{ animationDelay: `${600 + i * 70}ms` }}><i aria-hidden>x</i>{r}</li>)}
        </ul>
      </div>
      <p className="stage-note">Delivery today is the CRE CLI in simulation (one node), gated to one operator wallet. Production runs the same workflow on a DON with consensus, through the DON-signed forwarder and a workflow-pinned receiver.</p>
    </div>
  );
}

function StageRedeem() {
  const live = useLiveSeries();
  const demo = useSeries(demoSubject ?? live.subject);
  const lifecycle = useLifecycle(demoSubject ? demo.market : undefined, demoSubject ?? live.subject);
  const real = (lifecycle.data?.steps ?? []).flatMap((s) => s.proof?.redemptions ?? []);
  const longLeg = real.find((r) => r.long > 0n);
  const shortLeg = real.find((r) => r.short > 0n);
  if (demo.market?.state.settled && longLeg && shortLeg) {
    const cd = demo.market.collateral.decimals;
    const dec = demo.market.claims.decimals;
    const total = longLeg.payout + shortLeg.payout;
    return (
      <div className="stage-body stage-redeem">
        <div className="split-bar" role="img" aria-label="Long and short payouts from 1,000 pairs">
          <i className="l" style={{ width: `${Number((longLeg.payout * 10000n) / total) / 100}%` }} />
          <i className="s" style={{ width: `${Number((shortLeg.payout * 10000n) / total) / 100}%` }} />
        </div>
        <div className="split-row num">
          <span><small>LONG, {fixed(longLeg.long, dec, 0)} CLAIMS</small>{usd(longLeg.payout, cd, 6)}</span>
          <span><small>SHORT, {fixed(shortLeg.short, dec, 0)} CLAIMS</small>{usd(shortLeg.payout, cd, 6)}</span>
        </div>
        <p className="stage-note">
          From the settled fast demo: the index settled at {usd(demo.market.state.settlementPrice, demo.pd, 6)} inside a ${trimmed(raw(demo.market.terms.lower, demo.pd), 2, 2)} to ${trimmed(raw(demo.market.terms.upper, demo.pd), 2, 2)} band, so the long redeemed {usd(longLeg.payout, cd, 6)} and the short the rest. Read from each redemption&rsquo;s receipt.
        </p>
        <Src contract="ComputeMarket Redeemed" address={demoSubject?.contracts.market} block={demo.market.block.number} />
      </div>
    );
  }
  const band = live.band;
  const idx = live.index;
  const example = band && idx !== null ? payouts(1000n * 10n ** 6n, idx, band) : null;
  return (
    <div className="stage-body stage-redeem">
      {example && live.market ? (
        <>
          <div className="split-bar" role="img" aria-label="Payout split if the series settled at the current index">
            <i className="l" style={{ width: `${Number((example.long * 10000n) / (example.long + example.short || 1n)) / 100}%` }} />
            <i className="s" style={{ width: `${Number((example.short * 10000n) / (example.long + example.short || 1n)) / 100}%` }} />
          </div>
          <div className="split-row num">
            <span><small>LONG, 1,000 CLAIMS</small>{usd(example.long, 6, 2)}</span>
            <span><small>SHORT, 1,000 CLAIMS</small>{usd(example.short, 6, 2)}</span>
          </div>
          <p className="stage-note">If the series settled at today&rsquo;s index. The contract burns the claims and pays each leg its share, with a minimum payout you choose.</p>
        </>
      ) : <p className="stage-note">Waiting for a settled series.</p>}
    </div>
  );
}

export function Stage({ step }: { step: number }) {
  const reduce = useReducedMotion();
  const body = [<StageMint key="a" />, <StageTrade key="b" />, <StageIndex key="c" />, <StageSettle key="d" />, <StageRedeem key="e" />][step];
  return (
    <Frame title={TITLES[step] as string} count={`${step + 1}/5`} label={`Step ${step + 1}: ${TITLES[step]}`}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={step}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
        >
          {body}
        </m.div>
      </AnimatePresence>
    </Frame>
  );
}
