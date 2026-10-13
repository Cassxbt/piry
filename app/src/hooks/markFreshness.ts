import { config } from "../config";
import { useChainNow, useMark, useMarket } from "./chain";

export type FreshnessState = "fresh" | "stale" | "unknown" | "final";

export interface Freshness {
  state: FreshnessState;
  ageSeconds: number | null;
}

// Kuru rejects claim deposits and withdrawals when the feed's updatedAt is older than 1800 s. staleSeconds sits below
// that so the warning shows before the revert. A feed that cannot be read is unknown, never fresh. A settled feed is
// final: its timestamp is synthesized so exchanges keep working.
export function classifyFreshness(input: { updatedAt: bigint | null; isFinal: boolean; now: bigint | null; staleSeconds: number }): Freshness {
  if (input.isFinal) return { state: "final", ageSeconds: null };
  if (input.updatedAt === null || input.now === null) return { state: "unknown", ageSeconds: null };
  const age = Math.max(0, Number(input.now - input.updatedAt));
  return { state: input.staleSeconds > 0 && age > input.staleSeconds ? "stale" : "fresh", ageSeconds: age };
}

export const claimExitOpen = (f: Freshness) => f.state === "fresh" || f.state === "final";

// The short feed passes the long feed's freshness through unchanged, so one reading covers both claims.
export function useMarkFreshness(): Freshness {
  const market = useMarket();
  const mark = useMark().data;
  const now = useChainNow(market.data, market.dataUpdatedAt);
  const ok = mark?.status === "ok" ? mark : null;
  return classifyFreshness({ updatedAt: ok?.updatedAt ?? null, isFinal: ok?.isFinal === true, now, staleSeconds: config.markStaleSeconds });
}
