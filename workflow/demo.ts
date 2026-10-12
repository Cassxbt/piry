import { indexIdentity, type IndexTerms } from "./validation.js";

export const demoTerms: IndexTerms = {
  mode: "DEMO",
  sourceId: "piry-demo",
  datasetId: "a100-demo-v1",
  hardware: { model: "NVIDIA A100", memoryGiB: 80, gpuCount: 1, region: "demo-region" },
  currency: "USD",
  units: "USD/GPU-hour",
  priceDecimals: 6,
  slotSeconds: 3600,
  periodStart: 1791676800,
  periodEnd: 1791687600,
  maxPublicationAgeSeconds: 600,
};

const { maxPublicationAgeSeconds, ...datasetTerms } = demoTerms;

export const demoDataset = {
  schemaVersion: 1,
  ...datasetTerms,
  ...indexIdentity(demoTerms),
  publishedAt: demoTerms.periodEnd + 60,
  observations: ["2000000", "3000000", "2000000"].map((price, index) => ({
    slotStart: demoTerms.periodStart + index * demoTerms.slotSeconds,
    observedAt: demoTerms.periodStart + index * demoTerms.slotSeconds + 30,
    price,
  })),
};
