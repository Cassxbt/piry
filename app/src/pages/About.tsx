import { BlockHead } from "../components/site/Frame";
import { Milestone } from "../components/site/Milestone";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { PartnerNote } from "../components/PartnerNote";
import { links } from "../config/links";
import { liveSubject, useSeries } from "../hooks/live";
import { usePage } from "../hooks/usePage";
import { utc } from "../lib/format";

const RECORD = [
  ["Refuel", "Superteam Agentic Engineering grant recipient. Least-privilege USDC top-ups for autonomous agents over Circle CCTP."],
  ["Guise", "an agent service on OKX.AI with on-chain x402 settlement."],
  ["Talos", "Arc showcase entry."],
  ["Also", "Backed (CMC API), Sounding (Bitget AI), Starlane (Stellar agents)."],
] as const;

export default function About() {
  usePage("About", "Piry is built by cassxbt, a solo full-stack and Solidity engineer who trades perps and pays a floating GPU compute bill.");
  const live = useSeries(liveSubject);
  const settleWhen = live.market ? utc(live.market.terms.periodEnd) : "date from the chain";
  const liveDone = live.market?.state.settled === true;

  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead as="h1" kicker="Founder" title={<>Built by <em>cassxbt</em> — a solo full-stack and Solidity engineer.</>} />
          <p className="sub project-links">
            <a href={links.x} target="_blank" rel="noreferrer">X @cassxbt</a>
            {" · "}
            <a href={links.github} target="_blank" rel="noreferrer">GitHub Cassxbt</a>
          </p>
        </div>
      </header>

      <section className="block" aria-labelledby="story-title">
        <div className="wrap">
          <h2 className="sr-only" id="story-title">Why Piry exists</h2>
          <div className="about-copy">
            <Reveal>
              <p>I trade perps, and I have been liquidated on positions that were right a week later. That taught me the rule Piry is built on: a hedge that can liquidate you mid-month isn&rsquo;t a hedge. So Piry has no leverage, no margin calls and no liquidation. The most you can lose is what you paid.</p>
            </Reveal>
            <Reveal delay={0.04}>
              <p>I&rsquo;m also Piry&rsquo;s first user. I run autonomous agents and nodes around the clock — a self-hosted multi-agent stack and an AI video pipeline — and pay a floating compute bill every month across OpenRouter, Hugging Face, Vast.ai and DigitalOcean. That bill runs $65 to $100 a month, and it swung enough that I started hunting for cheaper providers just to keep it flat. Switching providers is not a hedge: when GPU rates move, my costs move, and there is nothing I can buy to fix it. CME&rsquo;s GPU futures are stuck in regulatory review and sized for institutions (730 GPU-hours a contract). Piry is the hedge I wanted: small, fully collateralized, settled by Chainlink, traded on Kuru.</p>
            </Reveal>
            <Reveal delay={0.08}>
              <h3 className="about-sub">Shipping record, 2026:</h3>
              <ul className="plain-list">
                {RECORD.map(([name, text]) => (
                  <li key={name}><strong>{name}</strong> — {text}</li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.12}>
              <p>I sit on both sides of this market: a trader who knows what liquidation does to a hedge, and a builder who pays the GPU bill.</p>
            </Reveal>
          </div>
          <PartnerNote quote={links.partnerQuote} />
        </div>
      </section>

      <section className="block" aria-labelledby="next-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="What’s next" title={<>Three milestones, <em>stated plainly</em></>} id="next-title" />
          </Reveal>
          <ol className="milestones">
            <Milestone i={0} phase="done" when="12 Oct 2026" title="A full lifecycle on Monad testnet, with refusals">
              A five-minute demo series settled and its evidence verifies in your browser. A replayed report and a bad dataset were refused on the record.
            </Milestone>
            <Milestone i={1} phase={liveDone ? "done" : "next"} when={settleWhen} title="The live series settles">
              The composite-index series has a real period and a real snapshot. When it settles, its report and any refusals appear on the evidence page, readable by anyone.
            </Milestone>
            <Milestone i={2} phase="later" when="After the first live series" title="Monthly average-price (TWAP) series">
              A series that settles on the average of the composite across the whole month, which matches a month of hourly billing. Testnet only until a licensed index, an audit and legal review are done.
            </Milestone>
          </ol>
          <p className="block-link"><SiteLink to="/roadmap" className="text-link">Full roadmap and stance</SiteLink></p>
        </div>
      </section>
    </>
  );
}
