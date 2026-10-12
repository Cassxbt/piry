import type { CompositeTerms } from "../validation.js";
import runpod from "./runpod-gpu-types.live.json" with { type: "json" };
import shadeform from "./shadeform-instance-types.live.json" with { type: "json" };
import verda from "./verda-instance-types.live.json" with { type: "json" };
import { akashTerms, liveGpuPrices, periodEnd, type Body } from "./akash-fixtures.js";

// Raw responses captured 2026-10-12T10:16Z (Akash: test/akash-gpu-prices.live.json, 09:54Z).
//   runpod-gpu-types.live.json: POST https://api.runpod.io/graphql with the query sourceRequest("runpod") sends.
//   shadeform-instance-types.live.json: GET https://api.shadeform.ai/v1/instances/types?gpu_type=H100&num_gpus=1 (10849 bytes, 13 listings).
//   verda-instance-types.live.json: GET https://api.verda.com/v1/instance-types. The full response is 143148 bytes
//   (sha256 32317af31f1761519531d44e3c82c01434debcfd3749c7610378c541f814a722, 79 entries), above the 64 KiB fixture
//   limit, so it is trimmed to 8 entries kept verbatim: every H100 entry plus three others.
export { periodEnd };

export const compositeTerms: CompositeTerms = {
  mode: "COMPOSITE",
  sourceId: "composite-h100-sxm-median",
  sources: {
    akash: { selector: akashTerms.selector, priceField: "weightedAverage", minProviders: 2 },
    runpod: { gpuTypeId: "NVIDIA H100 80GB HBM3", gpuCount: 1 },
    shadeform: { gpuType: "H100", numGpus: 1, interconnect: "sxm5", excludeClouds: ["verda"], minClouds: 4 },
    verda: { gpuDescription: "1x H100 SXM5 80GB", numberOfGpus: 1 },
  },
  minSources: 3,
  sanityBounds: { min: "0.50", max: "20.00" },
  priceDecimals: 6,
  periodStart: periodEnd - 86400,
  periodEnd,
  maxPublicationAgeSeconds: 3600,
};

export const liveBodies = {
  akash: (): Body => liveGpuPrices(),
  runpod: (): Body => structuredClone(runpod),
  shadeform: (): Body => structuredClone(shadeform),
  verda: (): Body => structuredClone(verda),
};

// Values the live captures extract to under compositeTerms.
export const expected = {
  akash: { value: 2730000n, count: 4 },
  runpod: { value: 2690000n, count: 1 },
  shadeform: { value: 4170000n, count: 4 },
  verda: { value: 4047000n, count: 2 },
  median: 3388500n,
};
