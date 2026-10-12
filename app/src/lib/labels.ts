import type { Phase } from "./reads";
import { usd } from "./format";

export const DELIVERY = {
  simulation: {
    short: "CRE CLI simulation, operator-gated",
    detail:
      "Reports reach the receiver through the CRE CLI's simulation forwarder from a single trusted operator wallet. There is no DON signature or workflow identity check. Production delivery uses the DON-signed forwarder with the workflow-pinned SettlementReceiver.",
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
