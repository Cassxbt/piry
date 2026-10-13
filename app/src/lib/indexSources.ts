import { parseUnits } from "viem";
import type { IndexComponent } from "../config/types";

export interface SourceSummary {
  total: number;
  valid: number;
  failed: number;
  pending: number;
  quorum: boolean | null;
}

// Counts what the operator has recorded. Whether a reading was accepted is decided by the workflow and shown
// by the chain; this only tells the reader how the recorded sources stand against the rule.
export function summarizeSources(components: readonly IndexComponent[], minValid: number | null): SourceSummary {
  const valid = components.filter((c) => c.status === "valid").length;
  const failed = components.filter((c) => c.status === "failed").length;
  const pending = components.length - valid - failed;
  return { total: components.length, valid, failed, pending, quorum: minValid === null || pending > 0 ? null : valid >= minValid };
}

// Median of the valid sources at the index's decimals. With an even count it is the mean of the two middle values,
// rounded down, which is the rule the live series states. Returns null when there is nothing valid to take.
export function medianOfValid(components: readonly IndexComponent[], decimals: number): bigint | null {
  const values = components
    .filter((c) => c.status === "valid" && c.value !== null)
    .map((c) => parseUnits(c.value as string, decimals))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (values.length === 0) return null;
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? (values[mid] as bigint) : ((values[mid - 1] as bigint) + (values[mid] as bigint)) / 2n;
}
