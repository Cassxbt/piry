import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAkash, extractRunpod, extractShadeform, extractVerda, fetchComposite, median, toMicro } from "../src/sources.js";

const akash = { models: [{ vendor: "nvidia", model: "h100", ram: "80Gi", interface: "SXM5", price: { currency: "USD", weightedAverage: 2.73 }, providerAvailability: { total: 4 } }, { vendor: "nvidia", model: "a100", ram: "80Gi", interface: "SXM4", price: { currency: "USD", weightedAverage: 1.1 }, providerAvailability: { total: 9 } }] };
const runpod = { data: { gpuTypes: [{ id: "NVIDIA H100 80GB HBM3", lowestPrice: { uninterruptablePrice: 2.69 } }] } };
const verda = [{ gpu: { description: "1x H100 SXM5 80GB", number_of_gpus: 1 }, currency: "usd", price_per_hour: "4.087" }, { gpu: { description: "8x H100 SXM5 80GB", number_of_gpus: 8 }, currency: "usd", price_per_hour: "30.0" }];
const cloud = (name: string, cents: number, extra = {}) => ({ cloud: name, hourly_price: cents, configuration: { gpu_type: "H100", num_gpus: 1, interconnect: "sxm5", ...extra } });
const shadeform = { instance_types: [cloud("a", 400), cloud("a", 450), cloud("b", 417), cloud("c", 430), cloud("d", 500), cloud("verda", 100), cloud("e", 300, { interconnect: "pcie" })] };

test("each extractor applies its selection rule", () => {
  assert.equal(extractAkash(akash), 2_730_000n);
  assert.equal(extractRunpod(runpod), 2_690_000n);
  assert.equal(extractVerda(verda), 4_087_000n);
  assert.equal(extractShadeform(shadeform), 4_235_000n); // cheapest per cloud 400,417,430,500 -> median of middle two
});

test("extractors fail closed on odd shapes", () => {
  assert.throws(() => extractAkash({ models: [] }));
  assert.throws(() => extractAkash({ models: [{ ...akash.models[0], providerAvailability: { total: 1 } }] }));
  assert.throws(() => extractRunpod({ data: { gpuTypes: [] } }));
  assert.throws(() => extractVerda([{ gpu: { description: "1x H100 SXM5 80GB", number_of_gpus: 1 }, currency: "eur", price_per_hour: "4" }]));
  assert.throws(() => extractShadeform({ instance_types: [cloud("a", 400), cloud("b", 410)] })); // fewer than 4 clouds
  assert.throws(() => extractShadeform({ instance_types: [cloud("a", 400.5)] }));
});

test("decimal text converts without float multiplication", () => {
  assert.equal(toMicro(2.73), 2_730_000n);
  assert.equal(toMicro("4.087"), 4_087_000n);
  assert.throws(() => toMicro(0));
  assert.throws(() => toMicro("-1"));
  assert.throws(() => toMicro(1e21));
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([1n, 2n, 3n, 4n]), 2n);
});

const respond = (map: Record<string, unknown | Error>) => async (url: string) => {
  const key = Object.keys(map).find((k) => url.includes(k))!;
  const v = map[key];
  if (v instanceof Error) throw v;
  return { ok: true, status: 200, text: async () => JSON.stringify(v) };
};

test("composite is the median of valid sources and needs 3 of 4", async () => {
  const all = await fetchComposite(respond({ akash: akash, runpod: runpod, verda: verda, shadeform: shadeform }));
  assert.equal(all.validSources, 4);
  assert.equal(all.indexUsd, "3.4085"); // median of 2.69, 2.73, 4.087, 4.235
  const three = await fetchComposite(respond({ akash: akash, runpod: new Error("down"), verda: verda, shadeform: shadeform }));
  assert.equal(three.validSources, 3);
  assert.equal(three.indexUsd, "4.087");
  assert.equal(three.readings.find((r) => r.source === "runpod")?.ok, false);
  const two = await fetchComposite(respond({ akash: akash, runpod: new Error("down"), verda: new Error("down"), shadeform: shadeform }));
  assert.equal(two.indexUsd, null);
});

test("a value outside the sanity bounds is dropped", async () => {
  const cheap = { data: { gpuTypes: [{ id: "NVIDIA H100 80GB HBM3", lowestPrice: { uninterruptablePrice: 0.1 } }] } };
  const c = await fetchComposite(respond({ akash: akash, runpod: cheap, verda: verda, shadeform: shadeform }));
  assert.equal(c.readings.find((r) => r.source === "runpod")?.ok, false);
  assert.equal(c.validSources, 3);
});

test("toMicro floors past six decimals instead of rejecting, as the workflow does", () => {
  assert.equal(toMicro("2.7399999999999999999"), 2_739_999n);
  assert.equal(toMicro("2.1234567890123"), 2_123_456n);
  assert.throws(() => toMicro("0.0000009"), /zero/);
});
