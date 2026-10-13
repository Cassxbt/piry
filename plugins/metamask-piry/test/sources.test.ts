import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalMicro, extractAkash, extractRunpod, extractShadeform, extractVerda, fetchComposite, median, numberToMicro, readSource } from "../src/sources.js";

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
  assert.equal(numberToMicro(2.73), 2_730_000n);
  assert.equal(decimalMicro("4.087"), 4_087_000n);
  assert.throws(() => numberToMicro(0));
  assert.throws(() => numberToMicro(-1));
  assert.throws(() => numberToMicro("2.69"), /finite positive number/);
  assert.throws(() => numberToMicro(Number.NaN));
  assert.throws(() => decimalMicro("-1"));
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([1n, 2n, 3n, 4n]), 2n);
});

const respond = (map: Record<string, unknown | Error>, status = 200) => async (url: string) => {
  const key = Object.keys(map).find((k) => url.includes(k))!;
  const v = map[key];
  if (v instanceof Error) throw v;
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  return { status, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
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

test("digits past six decimals are floored, as in the workflow, and a price that floors to zero fails the sanity bounds", async () => {
  assert.equal(decimalMicro("2.7399999999999999999"), 2_739_999n);
  assert.equal(decimalMicro("2.1234567890123"), 2_123_456n);
  assert.equal(decimalMicro("9e-7"), 0n);
  const tiny = { data: { gpuTypes: [{ id: "NVIDIA H100 80GB HBM3", lowestPrice: { uninterruptablePrice: 0.0000009 } }] } };
  const r = await readSource("runpod", respond({ runpod: tiny }) as never);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /sanity/);
});

test("the extractors accept and reject exactly what the workflow does", () => {
  const model = (patch: object) => ({ models: [{ ...akash.models[0], ...patch }, akash.models[1]] });
  assert.equal(extractAkash(model({ providerAvailability: { total: 2 } })), 2_730_000n);
  assert.throws(() => extractAkash(model({ providerAvailability: { total: 2.5 } })), /provider count/);
  assert.throws(() => extractAkash(model({ providerAvailability: { total: "4" } })), /provider count/);
  assert.throws(() => extractAkash(model({ price: { currency: "USD", weightedAverage: "2.73" } })), /finite positive number/);
  assert.equal(extractAkash({ models: [null, 7, "x", ...akash.models] }), 2_730_000n, "malformed unrelated entries are skipped");
  assert.throws(() => extractRunpod({ data: { gpuTypes: [{ id: "NVIDIA H100 80GB HBM3", lowestPrice: { uninterruptablePrice: "2.69" } }] } }), /finite positive number/);
  assert.equal(extractRunpod({ data: { gpuTypes: [null, 7, ...runpod.data.gpuTypes] } }), 2_690_000n);
  assert.equal(extractVerda([null, 7, ...verda]), 4_087_000n);
  assert.throws(() => extractVerda([{ ...verda[0], price_per_hour: "4.0479999999999" }]), /plain decimal string/);
  assert.equal(extractVerda([{ ...verda[0], price_per_hour: "4.047999999999" }]), 4_047_999n);
  assert.throws(() => extractVerda([{ ...verda[0], price_per_hour: 4.087 }]), /plain decimal string/);
  assert.equal(extractShadeform({ instance_types: [null, 3, { configuration: "x" }, ...shadeform.instance_types] }), 4_235_000n);
  assert.throws(() => extractShadeform({ instance_types: [...shadeform.instance_types, cloud("Bad Cloud", 400)] }), /invalid cloud name/);
  assert.throws(() => extractShadeform({ instance_types: [...shadeform.instance_types, { ...cloud("x", 400), cloud: 5 }] }), /invalid cloud name/);
});

test("a source is read only from an HTTP 200 and its size is measured in bytes", async () => {
  assert.equal((await readSource("runpod", respond({ runpod }, 200) as never)).ok, true);
  for (const status of [201, 204, 206, 304, 404]) assert.equal((await readSource("runpod", respond({ runpod }, status) as never)).reason, `HTTP ${status}`);
  const padded = (n: number) => async () => { const bytes = new TextEncoder().encode(JSON.stringify({ ...runpod, pad: "€".repeat(n) })); return { status: 200, arrayBuffer: async () => bytes.buffer as ArrayBuffer }; };
  assert.equal((await readSource("runpod", padded(22_000))).reason, "response exceeds 65536 bytes");
  assert.equal((await readSource("runpod", padded(100))).ok, true);
});

test("the composite is labelled a preview, not the accepted on-chain observation", async () => {
  const c = await fetchComposite(respond({ akash, runpod, verda, shadeform }) as never);
  assert.equal(c.kind, "PREVIEW");
  assert.match(c.note, /not the accepted on-chain observation/);
  assert.match(c.note, /fetched now/i);
});
