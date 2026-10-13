import { useFeedHistory } from "../../hooks/feedHistory";
import { liveSubject } from "../../hooks/live";
import { indexRange } from "../../lib/feedHistory";
import { trimmed } from "../../lib/numbers";

// Volatility claims should be about this index, so its own realized range sits next to the Ornn swing fact.
export function IndexRange() {
  const range = indexRange(useFeedHistory(liveSubject).data?.points ?? []);
  if (!range) return null;
  const change = range.changePct === null ? "" : `, ${range.changePct >= 0 ? "+" : ""}${range.changePct.toFixed(1)}% first to latest`;
  return (
    <p className="sub index-range num">
      This index so far: {range.rounds} feed rounds, range ${trimmed(range.low, 4, 4)} to ${trimmed(range.high, 4, 4)}{change}. The swing quoted under &ldquo;Why now&rdquo; is Ornn&rsquo;s index, not this one.
    </p>
  );
}
