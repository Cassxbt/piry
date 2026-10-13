import { useId, type ReactNode } from "react";

export const GLOSSARY = {
  mark: "The price the feed reports for one claim right now, between $0 and $1.",
  band: "The index price range, from a floor to a cap, inside which a claim pays out.",
  claim: "An ERC-20 token that redeems for dollars at settlement. The long claim pays more as the index rises; the short pays the rest.",
  CRE: "Chainlink Runtime Environment: Chainlink's framework for running a data-fetching workflow and reporting the result on-chain.",
} as const;

export function GlossaryLine() {
  return (
    <p className="sub glossary-line">
      <strong>Terms.</strong> <em>Claim</em>: {GLOSSARY.claim} <em>Band</em>: {GLOSSARY.band} <em>Mark</em>: {GLOSSARY.mark} <em>CRE</em>: {GLOSSARY.CRE}
    </p>
  );
}

// Inline definition on hover and keyboard focus; use it on the first appearance of a term on a page.
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children?: ReactNode }) {
  const id = useId();
  return (
    <span className="term" tabIndex={0} aria-describedby={id}>
      {children ?? k}
      <span role="tooltip" id={id} className="term-tip">{GLOSSARY[k]}</span>
    </span>
  );
}
