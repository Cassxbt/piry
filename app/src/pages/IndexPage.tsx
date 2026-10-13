import BandGauge from "../components/charts/BandGauge";
import { MarkHistoryChart } from "../components/charts/lazy";
import { Src } from "../components/Src";
import { SourceTable } from "../components/SourceTable";
import { BlockHead, Frame } from "../components/site/Frame";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { liveSubject, useLiveSeries } from "../hooks/live";
import { usePage } from "../hooks/usePage";
import { medianOfValid } from "../lib/indexSources";
import { shortHash } from "../lib/format";
import { raw, trimmed } from "../lib/numbers";

const FAILURES = [
  ["http-status", "The source answered with an error status."],
  ["response-too-large", "The response was bigger than the workflow will read."],
  ["invalid-response", "The response did not parse, or did not match the rule above."],
  ["outside-sanity-bounds", "The value fell outside the sanity bounds."],
  ["below-minimum-count", "Too few providers or clouds stood behind the value."],
  ["unavailable-or-no-consensus", "The nodes could not agree on a value, or could not reach the source."],
] as const;

export default function IndexPage() {
  usePage("The index", "Piry H100 Composite: the median of four public H100 SXM prices read by Chainlink CRE, with live values, the median rule, failure handling and a published sanity band.");
  const live = useLiveSeries();
  const { series } = liveSubject;
  const source = series.source;
  const band = source.sanityBand;
  const components = source.components;
  const recorded = components.filter((c) => c.value !== null);
  const feedIndex = live.mark?.status === "ok" && live.mark.indexPrice !== null ? { price: live.mark.indexPrice, label: `Feed round ${live.mark.roundId.toString()}` } : null;
  const median = medianOfValid(components, live.pd);
  const sanity = band?.value ? Number(band.value) : null;
  const medianNum = median !== null ? raw(median, live.pd) : live.index !== null ? raw(live.index, live.pd) : null;
  const diffPct = sanity !== null && medianNum !== null ? ((medianNum - sanity) / sanity) * 100 : null;
  const values = recorded.map((c) => Number(c.value));
  const spread = values.length > 1 ? ((Math.max(...values) - Math.min(...values)) / Math.min(...values)) * 100 : null;
  const L = live.band ? raw(live.band.lower, live.pd) : null;
  const U = live.band ? raw(live.band.upper, live.pd) : null;

  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="The index"
            title={<>Piry H100 <em>Composite</em></>}
            lede="One number everyone settles against: the median of four public H100 SXM prices, each read by its own Chainlink CRE call. It is built so that no single source decides the outcome, and so that a bad reading is refused instead of settled."
          />
        </div>
      </header>

      <section className="block" aria-labelledby="sources-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Four sources" index="1/5" title={<>Why these four, <em>and what each one measures</em></>} lede="Each source has a fixed rule, written into the workflow and hashed into the market's spec hash. A report built on different rules is refused by the contract." id="sources-title" />
          </Reveal>
          <div className="source-grid">
            {components.map((c, i) => (
              <Reveal key={c.name} delay={i * 0.06} className="source-card brackets">
                <p className="mono source-n">{String(i + 1).padStart(2, "0")} / {String(components.length).padStart(2, "0")}</p>
                <h3>{c.name}</h3>
                <p className="source-val num">{c.value !== null ? `$${c.value}` : "n/a"}<small>per GPU-hour, {c.status}</small></p>
                {c.rule ? <p><strong>Rule.</strong> {c.rule}</p> : null}
                {c.why ? <p><strong>Why it is here.</strong> {c.why}</p> : null}
              </Reveal>
            ))}
          </div>
          {live.market ? (
            <p className="sub spec-line">
              Spec hash on-chain: <span className="mono" title={live.market.terms.specHash}>{shortHash(live.market.terms.specHash)}</span>. Sources are read from fixed URLs, with plain HTTP calls and no API key.
            </p>
          ) : null}
        </div>
      </section>

      <section className="block" aria-labelledby="live-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Live values" index="2/5" title={<>The numbers, <em>checked against the chain</em></>} lede={`Recorded at ${source.componentsAsOf ?? "deployment"}. The median of those values is compared with what the mark feed holds, to the unit.`} id="live-title" />
          </Reveal>
          <div className="index-live">
            <Reveal className="index-table">
              <SourceTable components={components} minValid={source.minValid} asOf={source.componentsAsOf} decimals={live.pd} onchain={feedIndex} />
            </Reveal>
            <Reveal delay={0.06}>
              <Frame title="Feed rounds" count={live.mark?.status === "ok" ? live.mark.roundId.toString() : "0"} label="Mark feed rounds">
                <div className="frame-pad">
                  {live.band && L !== null && U !== null && live.index !== null ? (
                    <BandGauge lower={L} upper={U} markers={[{ value: raw(live.index, live.pd), label: `index $${trimmed(raw(live.index, live.pd), 2, 4)}`, tone: "accent" }]} money={(v) => `$${trimmed(v, 2, 2)}`} ariaLabel="Index on the payout band" />
                  ) : null}
                  <MarkHistoryChart subject={liveSubject} surface="paper" />
                  {live.market ? <Src contract="PiryMarkFeed" address={liveSubject.contracts.markFeed} block={live.mark?.status === "ok" ? live.mark.block : live.market.block.number} /> : null}
                </div>
              </Frame>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="block" aria-labelledby="rule-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="The rule" index="3/5" title={<>Median, <em>at least three of four</em></>} id="rule-title" />
          </Reveal>
          <div className="rule-grid">
            {[
              ["Per-source consensus", "Each source is read by its own CRE call, and the nodes agree on its value and count by taking the median of what they saw. One noisy source cannot sink the others."],
              ["Sanity bounds", source.bounds ? `A value outside $${source.bounds.min} to $${source.bounds.max} per GPU-hour is treated as a failure, so a malformed price cannot move the index.` : "Values are bounds-checked before they count."],
              ["Quorum", `The index is published only if at least ${source.minValid ?? 3} of ${components.length} sources are valid. With fewer, no report is built, and the market waits for a good one or for the fallback.`],
              ["The median", "With three valid sources it is the middle value. With four it is the mean of the two middle values, rounded down. The extremes never set the price."],
              ["Failures are recorded", "A failed source is written into the evidence with a fixed reason code, never free text, so the record shows which source failed and why."],
              ["One snapshot at the end", "Settlement is a snapshot taken at or just after the period end, and a report is refused once it is older than the market's maximum report age."],
            ].map(([head, body], i) => (
              <Reveal key={head} delay={(i % 3) * 0.05} className="rule-card">
                <h3>{head}</h3>
                <p>{body}</p>
              </Reveal>
            ))}
          </div>
          <details className="reasons">
            <summary>The six failure reason codes</summary>
            <dl>
              {FAILURES.map(([code, text]) => (
                <div key={code}><dt className="mono">{code}</dt><dd>{text}</dd></div>
              ))}
            </dl>
          </details>
        </div>
      </section>

      <section className="block" aria-labelledby="basis-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Basis disclosure" index="4/5" title={<>The sources disagree, <em>and a sanity band says by how much</em></>} lede="The composite measures cheapest on-demand listings, one GPU at a time. A published weekly median across many providers measures something nearby but different. Showing both is the honest way to say how far the number can be trusted." id="basis-title" />
          </Reveal>
          <div className="basis-grid">
            <Reveal className="basis-card brackets">
              <p className="mono">COMPOSITE (MEDIAN OF {recorded.length})</p>
              <p className="basis-num num">{medianNum !== null ? `$${trimmed(medianNum, 2, 6)}` : "n/a"}</p>
              <p className="sub">{median !== null ? "median of the recorded sources" : live.index !== null ? "from the feed" : "no reading yet"}</p>
            </Reveal>
            {band ? (
              <Reveal delay={0.06} className="basis-card brackets">
                <p className="mono">SANITY BAND</p>
                <p className="basis-num num">{band.value ? `$${band.value}` : "n/a"}</p>
                <p className="sub">
                  {band.url ? <a href={band.url} target="_blank" rel="noreferrer">{band.name}</a> : band.name}, {band.asOf}. {band.note} Licence: {band.license}.
                </p>
              </Reveal>
            ) : null}
            <Reveal delay={0.12} className="basis-card brackets">
              <p className="mono">HOW FAR APART</p>
              <p className="basis-num num">{diffPct !== null ? `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(2)}%` : "n/a"}</p>
              <p className="sub">
                composite against the sanity band{spread !== null ? `; the four sources themselves span ${spread.toFixed(0)}% from lowest to highest` : ""}.
              </p>
            </Reveal>
          </div>
          {sanity !== null ? (
            <ul className="vs-list num">
              {recorded.map((c) => {
                const d = ((Number(c.value) - sanity) / sanity) * 100;
                return <li key={c.name}><span>{c.name}</span><span>${c.value}</span><span>{d >= 0 ? "+" : ""}{d.toFixed(1)}% vs sanity band</span></li>;
              })}
            </ul>
          ) : null}
          <p className="callout">
            <strong>Why the gap matters.</strong> A hedge settles against this index, not against your provider&rsquo;s invoice. If your cloud prices sit well above or below the composite, the claims will still pay on the composite. The band keeps the composite honest against a source it does not control; it never feeds settlement.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="upgrade-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Production path" index="5/5" title={<>From public pages <em>to licensed feeds</em></>} id="upgrade-title" />
          </Reveal>
          <ol className="path-list">
            <li><Reveal><span className="mono">TODAY</span><div><strong>Public endpoints, read at settlement.</strong><p>This is enough to show the mechanism end to end on a testnet. Usage terms for building a derived index on these providers&rsquo; data have not been confirmed with each of them.</p></div></Reveal></li>
            <li><Reveal delay={0.05}><span className="mono">NEXT</span><div><strong>A licensed feed with a published methodology.</strong><p>GetDeploying&rsquo;s API is the first candidate, because its terms address index products. Ornn&rsquo;s compute price index, which ICE is building futures on, would be the strongest reference. Neither agreement exists today.</p></div></Reveal></li>
            <li><Reveal delay={0.1}><span className="mono">THEN</span><div><strong>Run the composite alongside a licensed index.</strong><p>Publish both for a full series before moving settlement, so holders can see how they differ before it matters.</p></div></Reveal></li>
          </ol>
          <p className="block-link"><SiteLink to="/roadmap" className="text-link">Read the roadmap</SiteLink></p>
        </div>
      </section>
    </>
  );
}
