import { JudgeAccess } from "../components/JudgeAccess";
import { GlossaryLine } from "../components/site/Term";
import { Reveal } from "../components/site/motion";
import { BlockHead } from "../components/site/Frame";
import { SeriesSwitch } from "../components/site/SeriesSwitch";
import { SiteLink } from "../components/site/SiteLink";
import { WalletButton } from "../components/WalletButton";
import { chain } from "../config";
import { useActiveSection } from "../hooks/useActiveSection";
import { usePage } from "../hooks/usePage";
import { Calculator } from "../sections/Calculator";
import { Position } from "../sections/Position";
import { Redeem } from "../sections/Redeem";
import { SeriesSection } from "../sections/Series";
import { Trade } from "../sections/Trade";

const IDS = ["series", "exposure", "trade", "position", "evidence-link", "redeem"] as const;
const STEPS = [
  { id: "series", n: "1", label: "Series" },
  { id: "exposure", n: "2", label: "Exposure" },
  { id: "trade", n: "3", label: "Trade" },
  { id: "position", n: "4", label: "Position" },
  { id: "evidence-link", n: "5", label: "Evidence" },
  { id: "redeem", n: "6", label: "Redeem" },
] as const;

function AppNav() {
  const active = useActiveSection(IDS);
  return (
    <nav className="app-nav" aria-label="App steps">
      <div className="wrap app-nav-row">
        {STEPS.map((s) => (
          <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>
            <span className="num">{s.n}</span>
            {s.label}
          </a>
        ))}
        <span className="app-nav-wallet"><WalletButton /></span>
      </div>
    </nav>
  );
}

function EvidenceLink() {
  return (
    <section className="app-section" id="evidence-link" aria-labelledby="evidence-link-title">
      <div className="wrap">
        <Reveal>
          <div className="evidence-link brackets">
            <div>
              <p className="mono kicker-line"><i className="sq" aria-hidden />5/6 SETTLEMENT EVIDENCE</p>
              <h2 className="block-title" id="evidence-link-title">What settled it, and what the system <em>refused</em></h2>
              <p className="lede">The accepted report and the refused reports found in the scanned block range (plus pinned records) sit on one ledger, rebuilt from on-chain events. It has its own page.</p>
            </div>
            <SiteLink to="/evidence" className="btn">Open the evidence ledger</SiteLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default function AppPage() {
  usePage("App", "Size a GPU price hedge, trade the claims on Kuru, check your position and redeem, on the live Piry series.");
  return (
    <>
      <header className="page-head">
        <div className="wrap">
          <BlockHead
            as="h1"
            kicker={`The app, ${chain.name}`}
            title={<>Size it, trade it, hold it, <em>redeem it</em></>}
            lede="The six steps a judge can walk end to end. Read-only works without a wallet; connect one to mint, trade, merge and redeem."
          />
          <div className="judge-wrap"><JudgeAccess /></div>
          <GlossaryLine />
          <SeriesSwitch />
        </div>
      </header>
      <AppNav />
      <SeriesSection />
      <Calculator />
      <Trade />
      <Position />
      <EvidenceLink />
      <Redeem />
    </>
  );
}
