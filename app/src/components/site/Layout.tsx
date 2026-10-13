import { links } from "../../config/links";
import { AnimatePresence, m, useReducedMotion, useScroll } from "motion/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { chain, config, explorer, primarySubject } from "../../config";
import { shortAddress } from "../../lib/format";
import { ThemeToggle } from "../ThemeToggle";
import { EASE_OUT } from "./motion";
import { SiteLink } from "./SiteLink";

const NAV = [
  { to: "/how-it-works", label: "How it works" },
  { to: "/index", label: "The index" },
  { to: "/built-on", label: "Built on" },
  { to: "/market", label: "Market" },
  { to: "/evidence", label: "Evidence" },
  { to: "/roadmap", label: "Roadmap" },
] as const;

function Wordmark() {
  return (
    <SiteLink to="/" className="wordmark" aria-label="Piry, home">
      <span className="wordmark-name">Piry</span>
      <span className="wordmark-tag">GPU price claims</span>
    </SiteLink>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="site-header">
      <div className="wrap bar">
        <Wordmark />
        <nav className="nav" aria-label="Pages">
          {NAV.map((item) => (
            <SiteLink key={item.to} to={item.to} nav>{item.label}</SiteLink>
          ))}
        </nav>
        <div className="bar-tools">
          <ThemeToggle />
          <SiteLink to="/app" className="btn small" nav>Open app</SiteLink>
          <button type="button" className="menu-btn" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      {open ? (
        <nav id="mobile-nav" className="mobile-nav" aria-label="Pages">
          <div className="wrap">
            {[{ to: "/", label: "Home" }, ...NAV, { to: "/app", label: "App" }].map((item, i) => (
              <SiteLink key={item.to} to={item.to} nav>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                {item.label}
              </SiteLink>
            ))}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function ProgressBar() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  if (reduce) return null;
  return <m.div className="progress" style={{ scaleX: scrollYProgress }} aria-hidden />;
}

// Scroll to the top on navigation, or to the hash target once the (lazy) page has rendered it.
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  }, []);
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    let tries = 0;
    const id = window.setInterval(() => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el || ++tries > 30) {
        window.clearInterval(id);
        el?.scrollIntoView({ block: "start" });
      }
    }, 60);
    return () => window.clearInterval(id);
  }, [pathname, hash]);
  return null;
}

function Footer() {
  const { market, markFeed, forwarder } = primarySubject.contracts;
  const link = (label: string, address: `0x${string}` | null) =>
    address ? (
      <li>
        <span>{label}</span>
        {explorer.address(address) ? (
          <a className="mono" href={explorer.address(address) as string} target="_blank" rel="noreferrer">{shortAddress(address)}</a>
        ) : (
          <span className="mono">{shortAddress(address)}</span>
        )}
      </li>
    ) : null;
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div className="footer-brand">
          <Wordmark />
          <p>
            Fully collateralized long and short claims on a GPU rental price index, on Monad. A prototype built for the Monad Metropolis hackathon, MIT licensed and built with AI assistance under human review.
          </p>
          <p>
            Cash-settled against a price index. Not insurance, no guarantee of reimbursement, and no compute is reserved or delivered. Not audited; {chain.name} only.
          </p>
        </div>
        <nav aria-label="Footer pages" className="footer-col">
          <h2>Pages</h2>
          <ul>
            {[{ to: "/", label: "Home" }, ...NAV, { to: "/app", label: "App" }].map((item) => (
              <li key={item.to}><SiteLink to={item.to}>{item.label}</SiteLink></li>
            ))}
          </ul>
        </nav>
        <div className="footer-col">
          <h2>Live contracts</h2>
          <ul>
            {link("Market", market)}
            {link("Mark feed", markFeed)}
            {link("Forwarder", forwarder)}
            {!market ? <li><span className="sub">None deployed on {config.chain.name}.</span></li> : null}
          </ul>
        </div>
        <div className="footer-col">
          <h2>Built on, and source</h2>
          <ul>
            <li><a href="https://docs.monad.xyz" target="_blank" rel="noreferrer">Monad docs</a></li>
            <li><a href="https://kuru-testnet-docs.mintlify.site" target="_blank" rel="noreferrer">Kuru docs</a></li>
            <li><a href="https://docs.chain.link/cre" target="_blank" rel="noreferrer">Chainlink CRE docs</a></li>
            {links.repo ? <li><a href={links.repo} target="_blank" rel="noreferrer">GitHub repository</a></li> : null}
            {links.videos ? <li><a href={links.videos} target="_blank" rel="noreferrer">Videos</a></li> : null}
            {config.chain.logsRpcUrl ? <li><span>RPC</span><a href="https://monad-foundation.notion.site/Crouton-Digital-RPC-endpoints-3dc6367594f2809d8ef5ce366b089282" target="_blank" rel="noreferrer">Crouton Digital</a></li> : null}
          </ul>
        </div>
      </div>
    </footer>
  );
}

function PageFallback() {
  return <div className="wrap page-fallback" role="status" aria-live="polite"><span className="spinner" aria-hidden /> Loading</div>;
}

export function SiteLayout() {
  const location = useLocation();
  const outlet = useOutlet();
  const reduce = useReducedMotion();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <ProgressBar />
      <Header />
      <ScrollManager />
      <AnimatePresence mode="wait" initial={false}>
        <m.main
          id="main"
          ref={main}
          tabIndex={-1}
          key={location.pathname}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        >
          <Suspense fallback={<PageFallback />}>{outlet}</Suspense>
        </m.main>
      </AnimatePresence>
      <Footer />
    </>
  );
}
