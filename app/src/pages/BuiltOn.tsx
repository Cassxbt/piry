import type { ReactNode } from "react";
import { BlockHead, Frame } from "../components/site/Frame";
import { CountUp, Reveal } from "../components/site/motion";
import { SiteLink } from "../components/site/SiteLink";
import { chain, config, explorer } from "../config";
import { useBlockNumber } from "../hooks/chain";
import { liveSubject, useLiveSeries } from "../hooks/live";
import { usePage } from "../hooks/usePage";
import { DELIVERY } from "../lib/labels";
import { shortAddress } from "../lib/format";
import { hostOf } from "../lib/logsClient";

const CROUTON = "https://monad-foundation.notion.site/Crouton-Digital-RPC-endpoints-3dc6367594f2809d8ef5ce366b089282";

function Band({ id, kicker, index, title, lede, children, facts }: { id: string; kicker: string; index: string; title: ReactNode; lede: ReactNode; children: ReactNode; facts: ReactNode }) {
  return (
    <section className="block" id={id} aria-labelledby={`${id}-title`}>
      <div className="wrap built-grid">
        <div>
          <Reveal>
            <BlockHead kicker={kicker} index={index} title={title} lede={lede} id={`${id}-title`} />
          </Reveal>
          <div className="built-copy">{children}</div>
        </div>
        <Reveal delay={0.06} className="built-facts">{facts}</Reveal>
      </div>
    </section>
  );
}

function AddressRow({ label, address }: { label: string; address: `0x${string}` | null }) {
  if (!address) return <div><dt>{label}</dt><dd className="sub">not deployed</dd></div>;
  const href = explorer.address(address);
  return (
    <div>
      <dt>{label}</dt>
      <dd>{href ? <a className="mono" href={href} target="_blank" rel="noreferrer">{shortAddress(address)}</a> : <span className="mono">{shortAddress(address)}</span>}</dd>
    </div>
  );
}

function MonadFacts() {
  const block = useBlockNumber();
  return (
    <Frame title="Monad" count="1/3" status={<span className="live-chip"><i className="dot" aria-hidden />{chain.name}</span>}>
      <dl className="facts-list">
        <div><dt>Latest block</dt><dd className="num"><CountUp value={block.data !== undefined ? Number(block.data) : null} format={(n) => Math.round(n).toLocaleString("en-US")} duration={1.2} /></dd></div>
        <div><dt>Block time</dt><dd className="num">{config.chain.blockTimeMs !== null ? `${config.chain.blockTimeMs} ms` : "n/a on this network"}</dd></div>
        <div><dt>Chain id</dt><dd className="num">{chain.id}</dd></div>
        <div><dt>Native token</dt><dd className="num">{config.chain.nativeSymbol}</dd></div>
        <div><dt>Reads</dt><dd>{hostOf(config.chain.rpcUrl)}</dd></div>
        <div>
          <dt>Event scans</dt>
          <dd>
            {config.chain.logsRpcUrl ? (
              <>RPC: <a href={CROUTON} target="_blank" rel="noreferrer">Crouton Digital</a>, up to {config.chain.logsMaxRange.toLocaleString("en-US")} blocks a query</>
            ) : <>{hostOf(config.chain.rpcUrl)}, {config.chain.getLogsMaxRange.toLocaleString("en-US")} blocks a query</>}
          </dd>
        </div>
      </dl>
      <footer className="frame-foot"><span>Ordinary reads use the primary RPC. Event scans use a second RPC with wider ranges and fall back to the primary if it errors.</span></footer>
    </Frame>
  );
}

function KuruFacts() {
  const live = useLiveSeries();
  const listed = config.kuru.longMarket !== null || config.kuru.shortMarket !== null;
  return (
    <Frame title="Kuru" count="2/3" status={<span className={`chip ${listed ? "ok" : "warn"} plain`}>{listed ? "listed" : "listing pending"}</span>}>
      <dl className="facts-list">
        <AddressRow label="AccountCore (custody)" address={config.kuru.accountCore} />
        <AddressRow label="Quote token" address={config.kuru.quoteToken} />
        <AddressRow label="PIRY-L / USDC market" address={config.kuru.longMarket} />
        <AddressRow label="PIRY-S / USDC market" address={config.kuru.shortMarket} />
        <AddressRow label="Price source, long claim" address={liveSubject.contracts.markFeed} />
        <AddressRow label="Price source, short claim" address={liveSubject.contracts.shortFeed} />
        <div><dt>Feed round</dt><dd className="num">{live.mark?.status === "ok" ? live.mark.roundId.toString() : "n/a"}</dd></div>
      </dl>
      <footer className="frame-foot"><span>Kuru&rsquo;s own contracts hold the custody and the book; Piry only reads and trades through them.</span></footer>
    </Frame>
  );
}

function CreFacts() {
  const { forwarder, receiver, markFeed } = liveSubject.contracts;
  const delivery = liveSubject.settlementMode ? DELIVERY[liveSubject.settlementMode] : null;
  return (
    <Frame title="Chainlink CRE" count="3/3" status={<span className="chip warn plain">{delivery ? "simulation" : "n/a"}</span>}>
      <dl className="facts-list">
        <AddressRow label="Forwarder (CRE mock)" address={forwarder} />
        <AddressRow label="Settlement receiver" address={receiver} />
        <AddressRow label="Mark feed" address={markFeed} />
        <div><dt>Mark cadence</dt><dd>{config.settlement.markCadence ?? "n/a"}</dd></div>
        <div><dt>Delivery</dt><dd>{delivery ? delivery.short : "n/a"}</dd></div>
      </dl>
      <footer className="frame-foot"><span>Every delivery is read back from the chain; see the evidence ledger.</span></footer>
    </Frame>
  );
}

const MATRIX = [
  ["Delivery", "cre workflow simulate --broadcast, through Chainlink's mock forwarder", "DON-signed KeystoneForwarder"],
  ["Who may deliver", "one operator wallet, checked by the receiver", "any DON-signed report from the pinned workflow"],
  ["Signatures", "none verified", "verified by the forwarder"],
  ["Receiver", "SimulationSettlementReceiver, demo only", "SettlementReceiver, pinned to the workflow ID"],
  ["Where it stands", "live on Monad testnet, with refusals on the record", "written and tested locally; not deployed, because CRE deploy access is not enabled for this account"],
] as const;

export default function BuiltOn() {
  usePage("Built on", "How Piry uses Monad, Kuru and Chainlink CRE, with live facts for each and an honest line between simulation and production.");
  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="Built on"
            title={<>Three pieces of infrastructure, <em>each doing one job</em></>}
            lede="Monad is fast enough to host the book and the marks, Kuru is where the claim trades, and Chainlink CRE is how a number from outside the chain becomes a settlement the contract will accept."
          />
        </div>
      </header>

      <Band
        id="monad"
        kicker="Monad"
        index="1/3"
        title={<>Short blocks make a hedging book <em>practical</em></>}
        lede="A hedge needs frequent marks and an order book people can adjust all day. On a chain with 400 ms blocks both are ordinary transactions."
        facts={<MonadFacts />}
      >
        <ul className="plain-list">
          <li><strong>Marks every 15 minutes.</strong> The mark feed takes a new round on a short cadence, so the price an exchange sees is never hours old.</li>
          <li><strong>An on-chain book.</strong> Kuru&rsquo;s order book runs as contracts on the same chain as the claims, so a fill and a redemption are the same kind of event.</li>
          <li><strong>Settlement is a transaction.</strong> The report, the check and the payout all happen on-chain, in blocks you can read.</li>
        </ul>
        <p className="sub">Piry runs on Monad testnet only. It is not audited and carries no real funds.</p>
      </Band>

      <Band
        id="kuru"
        kicker="Kuru"
        index="2/3"
        title={<>Where the claim trades, <em>and why the feed exists</em></>}
        lede="Kuru is an on-chain central limit order book. The long claim is the asset that trades there, quoted in USDC between $0 and $1."
        facts={<KuruFacts />}
      >
        <ul className="plain-list">
          <li><strong>A real book, not a pool.</strong> Hedgers and owners post and take at prices they choose, with limit orders, market orders and cancellations, all on-chain.</li>
          <li><strong>Kuru needs a price.</strong> Its custody requires a fresh price for any token that is deposited or withdrawn. The PiryMarkFeed exists for that: a Chainlink-style feed that reports the long claim&rsquo;s value in dollars, with the answer floored at one unit so a worthless claim stays withdrawable.</li>
          <li><strong>Where it stands.</strong> The Piry market is not listed yet; Kuru deploys markets on request. The app already reads a Kuru book, places and cancels orders and withdraws, and that flow ran end to end against Kuru&rsquo;s contracts on a local fork of Monad testnet. It has not yet run against a Piry market.</li>
        </ul>
      </Band>

      <Band
        id="cre"
        kicker="Chainlink CRE"
        index="3/3"
        title={<>A number from outside the chain, <em>that the contract will accept</em></>}
        lede="One CRE workflow has two handlers: a mark handler on a 15-minute schedule and a settlement handler at period end. Both read the same four public sources."
        facts={<CreFacts />}
      >
        <ul className="plain-list">
          <li><strong>Four external APIs.</strong> Akash, RunPod, Verda and Shadeform, each read with its own call and its own consensus among nodes, then reduced to a median.</li>
          <li><strong>A report the contract can check.</strong> The report names its chain, market, index, spec and period, and the market refuses anything that does not match, is stale, or arrives twice.</li>
          <li><strong>Refusals are part of the product.</strong> Each refused report is on the evidence page, because the forwarder reports success even when the receiver reverts, so the app reads events instead of a status.</li>
        </ul>
      </Band>

      <section className="block" aria-labelledby="matrix-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Simulation versus production" title={<>What is <em>real today</em>, and what is not</>} lede="Settlement on this deployment is real in the sense that its transactions are on Monad testnet. It is not yet trust-minimised, and this page says exactly where." id="matrix-title" />
          </Reveal>
          <Reveal delay={0.05}>
            <div className="table-wrap matrix">
              <table className="table responsive">
                <thead><tr><th></th><th>Today (this deployment)</th><th>Production</th></tr></thead>
                <tbody>
                  {MATRIX.map(([row, today, prod]) => (
                    <tr key={row}>
                      <td data-label="" className="matrix-row">{row}</td>
                      <td data-label="Today">{today}</td>
                      <td data-label="Production">{prod}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
          <p className="callout warn">
            <strong>Operator trust today.</strong> {DELIVERY.simulation.detail} That is why this is described as a demonstration of the mechanism and of its refusals, not as a trust-minimised oracle.
          </p>
          <p className="block-link"><SiteLink to="/evidence" className="text-link">See the refusals on the ledger</SiteLink></p>
        </div>
      </section>
    </>
  );
}
