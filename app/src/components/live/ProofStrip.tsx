import { useChainNow, useEvidenceFile, useSeriesShortMark } from "../../hooks/chain";
import { useDeliveryManifest } from "../../hooks/ledger";
import { useLifecycle } from "../../hooks/lifecycle";
import { demoSubject, liveSubject, useSeries } from "../../hooks/live";
import { duration, usd, utc } from "../../lib/format";
import { raw, trimmed } from "../../lib/numbers";
import { Src } from "../Src";
import { CountUp } from "../site/motion";
import { SiteLink } from "../site/SiteLink";

function LiveCell() {
  const live = useSeries(liveSubject);
  const now = useChainNow(live.market, live.marketUpdatedAt);
  const remaining = live.market && now !== null ? Number(live.market.terms.periodEnd - now) : null;
  return (
    <article className="proof-cell">
      <p className="proof-label"><i className="sq" aria-hidden />Live series</p>
      <p className="proof-value num">
        {live.market ? (remaining !== null && remaining > 0 ? duration(remaining) : "ended") : "n/a"}
      </p>
      <p className="proof-text">
        {live.market ? `to the period end, ${utc(live.market.terms.periodEnd)}; settlement is the first valid run after it` : "No live series is deployed on this network yet."}
      </p>
      {live.market ? <Src contract="ComputeMarket" address={liveSubject.contracts.market} block={live.market.block.number} /> : null}
    </article>
  );
}

function FeedCell() {
  const live = useSeries(liveSubject);
  const shortMark = useSeriesShortMark(liveSubject).data;
  const round = live.mark?.status === "ok" ? live.mark.roundId.toString() : null;
  return (
    <article className="proof-cell">
      <p className="proof-label"><i className="sq" aria-hidden />Mark feed{round ? `, round ${round}` : ""}</p>
      <p className="proof-value num">
        <CountUp value={live.index !== null ? raw(live.index, live.pd) : null} format={(n) => `$${trimmed(n, 4, 6)}`} />
      </p>
      <p className="proof-text">
        {live.mark?.status === "ok"
          ? `index published on-chain; the long claim is worth ${live.long !== null ? `$${trimmed(Number(live.long) / 1e8, 4, 6)}` : "n/a"}${shortMark?.status === "ok" ? `, the short $${trimmed(Number(shortMark.answer) / 10 ** shortMark.decimals, 4, 8)}` : ""}`
          : live.indexOrigin === "recorded" ? "median of the recorded sources; the feed has no round yet" : "the feed has no round yet"}
      </p>
      {live.mark?.status === "ok" ? <Src contract="PiryMarkFeed" address={liveSubject.contracts.markFeed} block={live.mark.block} /> : null}
    </article>
  );
}

function DemoCell() {
  const subject = demoSubject!;
  const demo = useSeries(subject);
  const evidence = useEvidenceFile(demo.market, subject);
  const verified = evidence.data?.check.hashMatches === true && evidence.data.check.priceMatches === true;
  return (
    <article className="proof-cell">
      <p className="proof-label"><i className="sq" aria-hidden />Fast demo, settled</p>
      <p className="proof-value num">
        {demo.market?.state.settled ? usd(demo.market.state.settlementPrice, demo.pd, 6) : "n/a"}
      </p>
      <p className="proof-text">
        {demo.market?.state.settled
          ? verified ? "settled by a CRE report; its evidence file hashes to the on-chain value in your browser" : "settled by a CRE report"
          : "the fast demo series has not settled"}
      </p>
      {demo.market ? <Src contract="ComputeMarket" address={subject.contracts.market} block={demo.market.block.number} /> : null}
    </article>
  );
}

function RefusalCell() {
  const subject = demoSubject;
  const demo = useSeries(subject ?? liveSubject);
  const lifecycle = useLifecycle(subject ? demo.market : undefined, subject ?? liveSubject);
  const manifest = useDeliveryManifest(subject ?? liveSubject);
  if (!subject) return null;
  const onchain = (lifecycle.data?.steps ?? []).filter((s) => s.proof?.forwarderResult === false).length;
  const offchain = manifest.data?.offchain.length ?? 0;
  return (
    <article className="proof-cell">
      <p className="proof-label"><i className="sq" aria-hidden />Refusals on record</p>
      <p className="proof-value num">{lifecycle.data ? onchain + offchain : "n/a"}</p>
      <p className="proof-text">
        {lifecycle.data ? `${onchain} refused on-chain (forwarder result false), ${offchain} stopped off-chain by the workflow` : "reading the run log"}
      </p>
      <SiteLink to="/evidence" className="proof-link">Open the ledger</SiteLink>
    </article>
  );
}

export function ProofStrip() {
  return (
    <div className="proof-strip" role="list">
      <div role="listitem"><LiveCell /></div>
      <div role="listitem"><FeedCell /></div>
      {demoSubject ? <div role="listitem"><DemoCell /></div> : null}
      {demoSubject ? <div role="listitem"><RefusalCell /></div> : null}
    </div>
  );
}
