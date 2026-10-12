import type { ReactNode } from "react";
import { chain, config } from "../config";
import { useActiveSection } from "../hooks/useActiveSection";
import { useBlockNumber } from "../hooks/chain";
import { blockLabel } from "../lib/format";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";

export const STEPS = [
  { id: "top", index: "01", label: "Overview" },
  { id: "exposure", index: "02", label: "Exposure" },
  { id: "trade", index: "03", label: "Trade" },
  { id: "position", index: "04", label: "Position" },
  { id: "evidence", index: "05", label: "Evidence" },
  { id: "redeem", index: "06", label: "Redeem" },
] as const;

const IDS = STEPS.map((s) => s.id);

function Wordmark() {
  return (
    <a className="wordmark" href="#top" aria-label="Piry, back to top">
      <span className="wordmark-name">Piry</span>
      <span className="wordmark-tag">GPU price claims</span>
    </a>
  );
}

function ChainStatus() {
  const block = useBlockNumber();
  return (
    <div className="rail-foot">
      <div className="row"><span>Network</span><span className="mono">{chain.name}</span></div>
      <div className="row">
        <span>Latest block</span>
        <span className="mono">{block.data !== undefined ? blockLabel(block.data) : block.isError ? "RPC unreachable" : "reading"}</span>
      </div>
      <div className="row"><span>Settlement</span><span className="mono">{config.settlementMode ?? "n/a"}</span></div>
      <p style={{ marginTop: 6 }}>Testnet prototype. Not audited. Claims settle against a price index; no compute is delivered.</p>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const active = useActiveSection(IDS);
  return (
    <div className="app">
      <a className="skip-link" href="#exposure">Skip to the calculator</a>
      <aside className="rail" aria-label="Judge journey">
        <div>
          <Wordmark />
          <nav className="rail-nav" aria-label="Sections">
            {STEPS.map((s) => (
              <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>
                <span className="num">{s.index}</span>
                <span>{s.label}</span>
              </a>
            ))}
          </nav>
        </div>
        <ChainStatus />
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="topbar-row">
            <Wordmark />
            <div className="topbar-tools">
              <ThemeToggle />
              <WalletButton />
            </div>
          </div>
          <nav className="stepnav stepnav-mobile" aria-label="Sections">
            {STEPS.map((s) => (
              <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>
                <span className="num">{s.index}</span>
                {s.label}
              </a>
            ))}
          </nav>
        </div>
        <main>{children}</main>
        <footer className="footer">
          <div className="content">
            <p>
              Piry is a prototype built for the Monad Metropolis hackathon, released under the MIT license. It was built with AI assistance under human review. Claims are cash-settled against a price index; they are not insurance, they guarantee no reimbursement, and no compute is reserved or delivered.
            </p>
            <p>Every on-chain figure on this page names the contract and block it was read from. Anything unavailable is shown as pending, never filled in.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
