export interface HedgeStudy {
  weeks: number;
  low: number;
  high: number;
  latest: number;
  // Weeks whose median sat outside the band.
  breaches: { below: number; above: number };
  // Percent change over 4 weeks, start-of-window to end-of-window, for every rolling window.
  change4w: { windows: number; p10: number; median: number; p90: number; worst: number; best: number };
  // Share of the variance of the month-average price removed by one claim sized to the band width (hedge ratio 1).
  varianceRemoved: { snapshot: number; average: number };
}

const MONTH_WEEKS = 4;

const clampToBand = (price: number, lower: number, upper: number) => Math.min(Math.max(price, lower), upper) - lower;

function variance(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

// Indicative only: weekly medians stand in for the hourly rate, payoffs are linear in price, the premium is a constant
// that does not change variance, and there is no basis between the index and a team's own invoice.
// Each rolling window opens at week t: the bill is the average of weeks t+1..t+4, a snapshot claim settles on week t+4,
// an average claim settles on that same four-week average.
export function studyHedge(prices: readonly number[], band: { lower: number; upper: number }): HedgeStudy | null {
  if (prices.length <= MONTH_WEEKS + 1) return null;
  const { lower, upper } = band;
  const bills: number[] = [];
  const snapshotHedged: number[] = [];
  const averageHedged: number[] = [];
  const changes: number[] = [];
  for (let t = 0; t + MONTH_WEEKS < prices.length; t++) {
    const month = prices.slice(t + 1, t + 1 + MONTH_WEEKS);
    const bill = month.reduce((a, b) => a + b, 0) / MONTH_WEEKS;
    const snapshot = prices[t + MONTH_WEEKS] as number;
    bills.push(bill);
    snapshotHedged.push(bill - clampToBand(snapshot, lower, upper));
    averageHedged.push(bill - clampToBand(bill, lower, upper));
    changes.push(((snapshot - (prices[t] as number)) / (prices[t] as number)) * 100);
  }
  const base = variance(bills);
  const removed = (hedged: readonly number[]) => (base === 0 ? 0 : 1 - variance(hedged) / base);
  const sorted = [...changes].sort((a, b) => a - b);
  return {
    weeks: prices.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    latest: prices[prices.length - 1] as number,
    breaches: { below: prices.filter((p) => p < lower).length, above: prices.filter((p) => p > upper).length },
    change4w: {
      windows: changes.length,
      p10: quantile(sorted, 0.1),
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      worst: sorted[0] as number,
      best: sorted[sorted.length - 1] as number,
    },
    varianceRemoved: { snapshot: removed(snapshotHedged), average: removed(averageHedged) },
  };
}
