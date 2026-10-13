import { BlockHead } from "../components/site/Frame";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { config } from "../config";
import { demoSubject, liveSubject, useSeries } from "../hooks/live";
import { usePage } from "../hooks/usePage";
import { utc } from "../lib/format";

type Phase = "done" | "next" | "later";
const PHASE_LABEL: Record<Phase, string> = { done: "Done", next: "Next", later: "Later" };

function Milestone({ phase, when, title, children, i }: { phase: Phase; when: string; title: string; children: React.ReactNode; i: number }) {
  return (
    <li className={`milestone milestone--${phase}`}>
      <Reveal delay={Math.min(i, 4) * 0.04}>
        <div className="milestone-head">
          <span className={`chip ${phase === "done" ? "ok" : phase === "next" ? "warn" : ""} plain`}>{PHASE_LABEL[phase]}</span>
          <span className="mono milestone-when">{when}</span>
        </div>
        <h3>{title}</h3>
        <p>{children}</p>
      </Reveal>
    </li>
  );
}

export default function Roadmap() {
  usePage("Roadmap", "How Piry builds liquidity on Kuru, where it stands legally and operationally, and the milestones from testnet to production.");
  const live = useSeries(liveSubject);
  const demo = useSeries(demoSubject ?? liveSubject);
  const kuruListed = config.kuru.longMarket !== null || config.kuru.shortMarket !== null;
  const settleWhen = live.market ? utc(live.market.terms.periodEnd) : "date from the chain";
  const demoDone = demoSubject !== null && demo.market?.state.settled === true;
  const liveDone = live.market?.state.settled === true;

  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="Roadmap"
            title={<>From a settled testnet series to <em>a market that holds</em></>}
            lede="The mechanism works end to end on testnet. What is left is liquidity, trust-minimised delivery and a licensed index, in that order of urgency."
          />
        </div>
      </header>

      <section className="block" aria-labelledby="mile-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Milestones" index="1/3" title={<>What is done, <em>what is next</em></>} id="mile-title" />
          </Reveal>
          <ol className="milestones">
            <Milestone i={0} phase={demoDone ? "done" : "next"} when="12 Oct 2026" title="A full lifecycle on Monad testnet, with refusals">
              Contracts, a CRE workflow, a mark feed and this app are live. A five-minute demo series settled, its evidence verifies in your browser, and a replayed report and a bad dataset were refused on the record.
            </Milestone>
            <Milestone i={1} phase={liveDone ? "done" : "next"} when={settleWhen} title="The live series settles">
              The composite-index series has a real period and a real snapshot. When it settles, its report, its evidence and any refusals appear on the evidence page, readable by anyone.
            </Milestone>
            <Milestone i={2} phase={kuruListed ? "done" : "next"} when={kuruListed ? "Live on Monad testnet" : "Pending Kuru"} title="PIRY-L / USDC and PIRY-S / USDC on Kuru">
              {kuruListed
                ? "Both claim markets are listed on Kuru's on-chain order book, each seeded with 10 resting orders. All of that resting liquidity is the team's own seeded orders; there are no independent market makers yet. The trade step reads the real books, the order ticket and the Kuru trading balance."
                : "Kuru deploys the markets on request. Once their addresses are set, the trade step goes live: the books, the order ticket and the trading balance."}
            </Milestone>
            <Milestone i={3} phase="later" when="When CRE deploy access is enabled" title="DON-signed delivery">
              Move from the simulation forwarder and its operator wallet to the DON-signed forwarder with a receiver pinned to the workflow ID. The strict receiver is written and tested; it is not deployed.
            </Milestone>
            <Milestone i={4} phase="later" when="After the first live series" title="Monthly average-price (TWAP) series">
              A series that settles on the average of the composite across the whole month, which matches a month of hourly billing. The live series settles on one reading (the first valid run after the period ends), so it hedges the rate you will be re-quoted on settlement day.
            </Milestone>
            <Milestone i={5} phase="later" when="Before any real funds" title="A licensed index">
              Replace public endpoints with a licensed feed under a written agreement, and run both side by side for a full series so holders can see the difference first.
            </Milestone>
            <Milestone i={6} phase="later" when="Before any real funds" title="Audit, and legal review">
              An independent audit of the contracts, and legal review in each jurisdiction a mainnet product would serve. Piry would not launch without either.
            </Milestone>
          </ol>
        </div>
      </section>

      <section className="block" aria-labelledby="liq-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Liquidity on Kuru" index="2/3" title={<>A book needs two sides, <em>so build both</em></>} lede="The first buyer has to meet a price. The plan is to make that true from day one, and then to recruit the side that is structurally missing." id="liq-title" />
          </Reveal>
          <ol className="plan-list">
            {[
              ["Seed both sides from collateral", "Today this is done: the resting liquidity on both books is the team's seeded orders, 10 per market. Mint pairs and quote both legs from one balance sheet: long asks and short bids around the mark. Inventory comes from collateral, not from borrowing, so seeding needs capital but no leverage."],
              ["Anchor quotes to the feed", "Quote around the PiryMarkFeed value, so a first buyer sees a price that is close to fair and a maker can tell when it has moved. The feed is checked every 5 minutes and published when the index moves, and at least every 20 minutes."],
              ["Maker incentives", "Design them with Kuru. Its book already has maker fees and application fees to start from; no incentive is designed or promised yet."],
              ["Recruit the short side", "GPU owners and lenders are the natural short. No partner is signed. The first conversations with them are the milestone that matters most."],
              ["Roll the series", "Run successive periods so exposure can be rolled, and keep a short fast series for demonstrations."],
            ].map(([head, body], i) => (
              <li key={head}>
                <Reveal delay={i * 0.04}>
                  <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                  <div><strong>{head}</strong><p>{body}</p></div>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="block" aria-labelledby="stance-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Legal and operational stance" index="3/3" title={<>Stated plainly, <em>so nobody has to guess</em></>} id="stance-title" />
          </Reveal>
          <div className="stance-grid">
            {[
              ["Testnet only", "Everything runs on Monad testnet with test collateral. No real funds are involved, and none should be."],
              ["Cash-settled, nothing delivered", "Claims settle in collateral against a price index. They are not insurance, they do not guarantee reimbursement of any invoice, and no compute is reserved or delivered."],
              ["Not audited", "The contracts are tested but not independently audited. Read the code before trusting a number."],
              ["Operator trust today", "Reports are delivered by one operator wallet through the CRE simulation forwarder. Production delivery removes that trust, and is on the list above."],
              ["Data terms", "Public endpoints are read without agreements. A mainnet index needs a licensed source."],
              ["Regulation", "A derivative on a price index needs legal review wherever it is offered. That review is a precondition for mainnet, not an afterthought."],
            ].map(([head, body], i) => (
              <Reveal key={head} delay={(i % 3) * 0.05} className="stance-card brackets">
                <h3>{head}</h3>
                <p>{body}</p>
              </Reveal>
            ))}
          </div>
          <p className="block-link">
            <SiteLink to="/evidence" className="text-link">Check the record yourself</SiteLink>
          </p>
        </div>
      </section>
    </>
  );
}
