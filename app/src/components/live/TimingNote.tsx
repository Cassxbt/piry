import { utc } from "../../lib/format";

// The live series settles on one snapshot, not an average of a month of hourly rates; say so wherever a "monthly bill" appears.
export function TimingNote({ periodEnd }: { periodEnd: bigint | undefined }) {
  return (
    <p className="sub timing-note">
      Timing: the live series settles on one reading of the composite: the first valid workflow run after the period ends{periodEnd !== undefined ? ` (${utc(periodEnd)})` : ""}, on a full four-source quorum for the first 4 hours, within a 24-hour window. It does not average a month of hourly billing, so the hedge locks the rate you will be re-quoted on settlement day. A monthly average-price (TWAP) series is on the roadmap.
    </p>
  );
}
