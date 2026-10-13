import { utc } from "../../lib/format";

// The live series settles on one snapshot, not an average of a month of hourly rates; say so wherever a "monthly bill" appears.
export function TimingNote({ periodEnd }: { periodEnd: bigint | undefined }) {
  return (
    <p className="sub timing-note">
      Timing: the live series settles on one reading of the composite, taken when the first valid workflow run after the period ends{periodEnd !== undefined ? ` (${utc(periodEnd)})` : ""} executes, up to 24 hours later (the keeper insists on all four sources for the first 4 hours). It is a snapshot of catalogue prices, not an average of a month of hourly billing, so it does not lock a monthly compute bill. A monthly average-price (TWAP) series is on the roadmap.
    </p>
  );
}
