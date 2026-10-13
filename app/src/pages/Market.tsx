import { BlockHead } from "../components/site/Frame";
import { Cites } from "../components/site/Cites";
import { Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { whyNow } from "../content/whyNow";
import { usePage } from "../hooks/usePage";

const COMPARE = [
  {
    kind: "Leveraged perpetual",
    pays: "Linear in price, without a limit",
    limits: "Needs margin and can be liquidated, and a funding rate is paid while you hold it. A hedge that can be liquidated is not a hedge.",
  },
  {
    kind: "Binary prediction market",
    pays: "All or nothing at a threshold",
    limits: "Pays the same whether the price barely crosses or far overshoots, so it cannot be sized to cover a GPU bill.",
  },
  {
    kind: "Exchange-listed futures",
    pays: "Scaled to the index",
    limits: "Not trading yet for GPU rental prices: CME's review runs to 9 November 2026 and ICE's listing awaits approval. Cleared and margined, with account access that is not open to everyone.",
  },
  {
    kind: "Physical GPU-hour marketplace",
    pays: "Compute itself",
    limits: "Delivers the hours at the price on the day. It does not protect the price of the hours you have not bought yet.",
  },
  {
    kind: "Piry claim",
    pays: "Scaled to the index inside a band, capped at the cap",
    limits: "Fully collateralized, with no margin, funding or liquidation. The most you can lose is the premium. The hedge stops paying at the cap, and it settles against an index, not your invoice.",
    us: true,
  },
] as const;

export default function Market() {
  usePage("Market", "Who the first Piry users are, why a GPU price hedge does not exist yet, and how a fully collateralized capped claim differs from perps, prediction markets and GPU marketplaces.");
  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="The market"
            title={<>Two people who want <em>opposite</em> exposure to the same number</>}
            lede="Someone who buys GPU hours is hurt when the price rises. Someone who owns or finances GPUs is hurt when it falls. Until now neither could hedge on-chain, in size, without margin."
          />
        </div>
      </header>

      <section className="block" aria-labelledby="users-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="First users" index="1/3" title={<>Who buys the long, <em>who takes the short</em></>} id="users-title" />
          </Reveal>
          <div className="persona-grid">
            <Reveal className="persona brackets">
              <p className="mono persona-tag persona-tag--long">LONG</p>
              <h3>Inference startups with fixed-price plans</h3>
              <p>They sell tokens or subscriptions at a price set weeks ahead and buy GPU hours at whatever the rate is that day. A rate spike comes straight out of the margin they promised.</p>
              <dl>
                <div><dt>Buys</dt><dd>Long claims on Kuru, sized to next month&rsquo;s GPU-hours</dd></div>
                <div><dt>Gets</dt><dd>A payout that rises with the index, up to the cap</dd></div>
                <div><dt>Risks</dt><dd>The premium, if prices stay low</dd></div>
              </dl>
            </Reveal>
            <Reveal delay={0.07} className="persona brackets">
              <p className="mono persona-tag persona-tag--short">SHORT</p>
              <h3>GPU owners and lenders</h3>
              <p>An owner&rsquo;s revenue and a lender&rsquo;s collateral both lose value when rental rates fall. In principle that risk is what a lender would charge for in loan terms; a short claim lets them hedge it directly instead.</p>
              <dl>
                <div><dt>Takes</dt><dd>The short, by minting a pair and selling the long</dd></div>
                <div><dt>Gets</dt><dd>A payout that rises as the index falls, plus the premium</dd></div>
                <div><dt>Risks</dt><dd>Giving up gains if rates rise past the cap</dd></div>
              </dl>
            </Reveal>
          </div>
          <p className="callout">
            <strong>Honest status.</strong> These are the first users Piry is built for. No customer, partner or liquidity provider is claimed: the series is on testnet, and the short side is exactly the one that needs to be recruited. The roadmap says how.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="why-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Why now" index="2/3" title={<>The demand is visible, <em>and the products are not live</em></>} lede="Every line links to the page it comes from." id="why-title" />
          </Reveal>
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
        </div>
      </section>

      <section className="block" aria-labelledby="diff-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="How Piry differs" index="3/3" title={<>Not a perp, not a bet, <em>not a marketplace</em></>} lede="Each of these solves a different problem. Piry is the one built to hold a price steady." id="diff-title" />
          </Reveal>
          <Reveal delay={0.05}>
            <div className="table-wrap compare">
              <table className="table responsive">
                <thead><tr><th>Instrument</th><th>What it pays</th><th>Limits</th></tr></thead>
                <tbody>
                  {COMPARE.map((row) => (
                    <tr key={row.kind} className={"us" in row ? "is-piry" : undefined}>
                      <td data-label="Instrument"><strong>{row.kind}</strong></td>
                      <td data-label="Pays">{row.pays}</td>
                      <td data-label="Limits">{row.limits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
          <p className="callout">
            <strong>Complementary, not competing.</strong> A GPU marketplace gets you the compute. Piry holds the price of the compute you will need next month. A team can use both: rent where it is cheapest, and hedge the rate it expects to pay.
          </p>
          <p className="block-link">
            <SiteLink to="/app" hash="exposure" className="text-link">Size a hedge for your GPUs</SiteLink>
            {"  "}
            <SiteLink to="/roadmap" className="text-link">How the market gets built</SiteLink>
          </p>
        </div>
      </section>
    </>
  );
}
