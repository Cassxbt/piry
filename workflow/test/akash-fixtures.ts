import type { AkashTerms } from "../validation.js";
import live from "./akash-gpu-prices.live.json" with { type: "json" };

// test/akash-gpu-prices.live.json is the unmodified response of GET https://console-api.akash.network/v1/gpu-prices
// captured 2026-10-12T09:54:51Z (HTTP 200, 8356 bytes).
export const periodEnd = 1791799200;

export const akashTerms: AkashTerms = {
  mode: "AKASH",
  sourceId: "akash-console-gpu-prices",
  selector: { vendor: "nvidia", model: "h100", ram: "80Gi", interface: "SXM5" },
  priceField: "weightedAverage",
  minProviders: 2,
  sanityBounds: { min: "0.50", max: "20.00" },
  priceDecimals: 6,
  periodStart: periodEnd - 86400,
  periodEnd,
  maxPublicationAgeSeconds: 3600,
};

export type Body = any;
export const liveGpuPrices = (): Body => structuredClone(live);
export const h100 = (body: Body): Body => body.models.find((model: Body) => model.model === "h100" && model.interface === "SXM5");
