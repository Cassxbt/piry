import { config } from "../config";
import { useChainNow, useMark, useMarket } from "./chain";

// True when the feed's last update is older than markStaleSeconds. Kuru rejects claim deposits and withdrawals past 1800 s,
// and markStaleSeconds sits below that so the warning shows before the revert.
export function useMarkFreshness(): { stale: boolean; ageSeconds: number | null } {
  const market = useMarket();
  const mark = useMark().data;
  const now = useChainNow(market.data, market.dataUpdatedAt);
  if (mark?.status !== "ok" || mark.isFinal || now === null) return { stale: false, ageSeconds: null };
  const age = Number(now - mark.updatedAt);
  return { stale: config.markStaleSeconds > 0 && age > config.markStaleSeconds, ageSeconds: Math.max(0, age) };
}
