import { demoDataset, demoTerms } from "../demo.js";

export function partialDataset(completedSlots: number, publishedAt = demoTerms.periodStart + completedSlots * demoTerms.slotSeconds + 60) {
  return { ...structuredClone(demoDataset), publishedAt, observations: structuredClone(demoDataset.observations).slice(0, completedSlots) };
}

// The spot observation comes from the latest slot completed at publication, on the grid extended backwards from periodStart.
export function spotDataset(publishedAt = demoTerms.periodStart - 600, price = "2100000") {
  const { slotSeconds, periodStart } = demoTerms;
  const slotStart = periodStart + (Math.floor((publishedAt - periodStart) / slotSeconds) - 1) * slotSeconds;
  return { ...structuredClone(demoDataset), publishedAt, observations: [{ slotStart, observedAt: slotStart + 30, price }] };
}
