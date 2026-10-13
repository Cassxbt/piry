import type { EvidenceState } from "./evidence";
import type { Phase } from "./reads";
import { usd } from "./format";

// How the keeper refreshes the mark feed. This is a target, not a guarantee: Kuru's claim deposits and withdrawals need
// a price no older than 30 minutes, and the age of the latest mark is shown beside it.
export const MARK_CADENCE = "checked every 5 minutes; published when the index moves, and at least every 20 minutes (Kuru's claim deposits and withdrawals need a price no more than 30 minutes old; the observed age is shown next to the mark)";

export const DELIVERY = {
  simulation: {
    short: "CRE CLI simulation, operator-gated",
    detail:
      "Reports reach the receiver through the CRE CLI's simulation forwarder from a single trusted operator wallet. The receiver checks the transaction origin (tx.origin) against that wallet, so the operator must never call an untrusted contract: it could route a report of its own choosing through the forwarder. There is no DON signature or workflow identity check. Production delivery uses the DON-signed forwarder with the workflow-pinned SettlementReceiver.",
  },
  strict: {
    short: "DON-signed forwarder, workflow-pinned receiver",
    detail: "Reports are accepted only from the Chainlink forwarder with the pinned workflow ID.",
  },
} as const;

export function phaseLabel(phase: Phase): { text: string; tone: "ok" | "warn" | "bad" | "plain" } {
  switch (phase) {
    case "pre-period":
      return { text: "Open: period not started", tone: "ok" };
    case "in-period":
      return { text: "Open: period running", tone: "ok" };
    case "awaiting-settlement":
      return { text: "Awaiting settlement", tone: "warn" };
    case "fallback-window":
      return { text: "Fallback available", tone: "warn" };
    case "settled":
      return { text: "Settled by report", tone: "ok" };
    case "settled-fallback":
      return { text: "Settled by fallback", tone: "warn" };
  }
}

// The feed floors its answer at 1e-8 USD so an exchange never sees a zero price; show that honestly.
export function markLabel(answer: bigint, decimals: number, fractionDigits = 4): string {
  return answer <= 1n ? "$0.00 (floor)" : usd(answer, decimals, fractionDigits);
}

// How a settled market got its price, and what the browser could do with its evidence. A fallback has no dataset.
export function settlementLabel(state: { settled: boolean; settledByFallback: boolean }, evidence: EvidenceState | undefined): { title: string; text: string } {
  if (!state.settled) return { title: "not settled", text: "has not settled" };
  if (state.settledByFallback) {
    return { title: "settled by fallback", text: "settled by the permissionless fallback at the band midpoint; no CRE report or dataset is behind this price" };
  }
  const tail =
    evidence === "verified" ? "its evidence file re-derives the price in your browser"
    : evidence === "failed" ? "its evidence file failed verification in your browser"
    : evidence === "unverified" ? "its evidence hash matches, but this page cannot re-derive the price"
    : "its evidence file is not available to check";
  return { title: "settled by CRE report", text: `settled by a CRE simulation report; ${tail}` };
}
