import type { ReactNode } from "react";
import { Reveal } from "./motion";

export type Phase = "done" | "next" | "later";
const PHASE_LABEL: Record<Phase, string> = { done: "Done", next: "Next", later: "Later" };

export function Milestone({ phase, when, title, children, i }: { phase: Phase; when: string; title: string; children: ReactNode; i: number }) {
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
