import { TractionPanel } from "../components/live/TractionPanel";
import { Reveal } from "../components/site/motion";
import { BlockHead } from "../components/site/Frame";
import { usePage } from "../hooks/usePage";
import { EvidenceBody } from "../sections/Evidence";

export default function EvidencePage() {
  usePage("Evidence", "The settlement ledger: accepted reports and the refused ones found in the scanned range for each Piry series, rebuilt from on-chain events, with the evidence file checked in your browser where its methodology is supported.");
  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker="Settlement evidence"
            title={<>What settled it, and what the system <em>refused</em></>}
            lede="A settlement is only worth trusting if the failures are on the record too. For each series the ledger puts the accepted report beside the reports the contracts turned away that were found in the scanned block range, plus pinned records, each rebuilt from on-chain events. The range is shown under each ledger. The CRE simulation forwarder reports success even when the receiver reverts, so nothing here is read from a status."
          />
        </div>
      </header>
      <section className="block block--flush">
        <div className="wrap">
          <EvidenceBody />
        </div>
      </section>
      <section className="block" aria-labelledby="traction-title">
        <div className="wrap">
          <Reveal>
            <BlockHead kicker="Traction" title={<>Who has used the markets, <em>and who is us</em></>} lede="Trades on both Kuru books and pair activity on the market contract, split into labelled team wallets and everyone else, who are unclassified rather than verified independent users." id="traction-title" />
          </Reveal>
          <Reveal delay={0.05}><TractionPanel /></Reveal>
        </div>
      </section>
    </>
  );
}
