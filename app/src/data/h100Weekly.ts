// Vendored rows from GetDeploying's weekly GPU price dataset (nvidia-h100, ON_DEMAND, median_price), the {len(rows)} weeks from
// 2025-10-13 to 2026-10-12. Source: https://getdeploying.com/dataset/gpu-prices/weekly.csv, fetched 13 Oct 2026.
// Licence: CC BY 4.0, credit GetDeploying. Used only for the indicative hedge-effectiveness note, never for settlement.
export interface WeeklyPrice {
  date: string;
  median: number;
  providers: number;
}

export const H100_WEEKLY_SOURCE = {
  name: "GetDeploying weekly GPU price dataset",
  url: "https://getdeploying.com/dataset/gpu-prices/weekly.csv",
  license: "CC BY 4.0",
  fetched: "13 Oct 2026",
} as const;

export const H100_WEEKLY_ON_DEMAND: readonly WeeklyPrice[] = [
  { date: "2025-10-13", median: 2.98, providers: 36 },
  { date: "2025-10-20", median: 2.98, providers: 36 },
  { date: "2025-10-27", median: 2.98, providers: 36 },
  { date: "2025-11-03", median: 2.98, providers: 36 },
  { date: "2025-11-10", median: 2.9533, providers: 37 },
  { date: "2025-11-17", median: 2.95, providers: 38 },
  { date: "2025-11-24", median: 2.89, providers: 38 },
  { date: "2025-12-01", median: 2.89, providers: 38 },
  { date: "2025-12-08", median: 2.89, providers: 38 },
  { date: "2025-12-15", median: 2.81, providers: 38 },
  { date: "2025-12-22", median: 2.81, providers: 38 },
  { date: "2025-12-29", median: 2.73, providers: 38 },
  { date: "2026-01-05", median: 2.73, providers: 38 },
  { date: "2026-01-12", median: 2.69, providers: 38 },
  { date: "2026-01-19", median: 2.89, providers: 38 },
  { date: "2026-01-26", median: 2.89, providers: 38 },
  { date: "2026-02-02", median: 2.94, providers: 34 },
  { date: "2026-02-09", median: 2.94, providers: 34 },
  { date: "2026-02-16", median: 2.865, providers: 35 },
  { date: "2026-02-23", median: 2.53, providers: 36 },
  { date: "2026-03-02", median: 2.49, providers: 36 },
  { date: "2026-03-09", median: 2.49, providers: 36 },
  { date: "2026-03-16", median: 2.49, providers: 36 },
  { date: "2026-03-23", median: 2.49, providers: 36 },
  { date: "2026-03-30", median: 2.5, providers: 36 },
  { date: "2026-04-06", median: 2.49, providers: 36 },
  { date: "2026-04-13", median: 2.495, providers: 37 },
  { date: "2026-04-20", median: 2.59, providers: 37 },
  { date: "2026-04-27", median: 2.5, providers: 37 },
  { date: "2026-05-04", median: 2.59, providers: 37 },
  { date: "2026-05-11", median: 2.64, providers: 37 },
  { date: "2026-05-18", median: 2.8578, providers: 37 },
  { date: "2026-05-25", median: 2.8033, providers: 38 },
  { date: "2026-06-01", median: 2.9375, providers: 39 },
  { date: "2026-06-08", median: 2.76, providers: 40 },
  { date: "2026-06-15", median: 2.8019, providers: 39 },
  { date: "2026-06-22", median: 2.73, providers: 38 },
  { date: "2026-06-29", median: 2.8725, providers: 40 },
  { date: "2026-07-06", median: 2.99, providers: 39 },
  { date: "2026-07-13", median: 2.89, providers: 40 },
  { date: "2026-07-20", median: 2.99, providers: 40 },
  { date: "2026-07-27", median: 3.11, providers: 40 },
  { date: "2026-08-03", median: 3.25, providers: 40 },
  { date: "2026-08-10", median: 3.29, providers: 39 },
  { date: "2026-08-17", median: 3.25, providers: 41 },
  { date: "2026-08-24", median: 3.2, providers: 41 },
  { date: "2026-08-31", median: 3.1387, providers: 40 },
  { date: "2026-09-07", median: 3.2, providers: 40 },
  { date: "2026-09-14", median: 3.15, providers: 39 },
  { date: "2026-09-21", median: 3.225, providers: 43 },
  { date: "2026-09-28", median: 3.3204, providers: 41 },
  { date: "2026-10-05", median: 3.4092, providers: 41 },
  { date: "2026-10-12", median: 3.73, providers: 41 },
];
