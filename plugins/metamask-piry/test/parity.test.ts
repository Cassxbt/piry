import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { formatUnits } from "viem";
import { SOURCE_NAMES, fetchComposite, readSource, sourceRequest, type SourceName } from "../src/sources.js";

// Differential test: the plugin's source rules against the Chainlink workflow's own code, fed identical bodies. The
// workflow modules are loaded at run time (not type-checked here) so the plugin keeps its own tsconfig.
const workflowDir = new URL("../../../workflow/", import.meta.url).pathname;
const present = existsSync(join(workflowDir, "composite.ts"));
const load = (file: string) => import(pathToFileURL(join(workflowDir, file)).href);
const [composite, onchain, fixtures] = present
  ? await Promise.all([load("composite.ts"), load("onchain.ts"), load("test/composite-fixtures.ts")])
  : [null, null, null];
const run = present ? test : test.skip;

type Body = any;
const terms = fixtures?.compositeTerms;
const bytesOf = (body: unknown): Uint8Array => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
const good = (value: bigint, count: number) => ({ ok: true as const, value, count });
const NOW = (terms?.periodEnd ?? 0) - 3600;

const requester = (statusCode: number, body: Uint8Array) => ({ sendRequest: () => ({ result: () => ({ statusCode, body }) }) });

// What the workflow does with one response: fetchSource (status, size, JSON), extractSource, then the DON-side
// acceptance in compositeSnapshot, observed through the other three sources being known-good.
function workflowOutcome(source: SourceName, status: number, raw: Uint8Array): { ok: boolean; value?: bigint } {
  const results: Record<string, unknown> = { akash: good(3_000_000n, 10), runpod: good(3_000_000n, 1), shadeform: good(3_000_000n, 10), verda: good(3_000_000n, 2) };
  try {
    const { url, body, maxBytes } = composite.sourceRequest(source, terms);
    const data = onchain.fetchSource(requester(status, raw), url, { body, maxBytes });
    results[source] = { ok: true, ...composite.extractSource(source, data, terms) };
  } catch (error) {
    results[source] = { ok: false, reason: composite.failureReason(error instanceof Error ? error.message : String(error)) };
  }
  const entry = JSON.parse(composite.compositeSnapshot(results, terms, NOW, "mark").canonicalEvidence).sources[source];
  return entry.ok ? { ok: true, value: BigInt(entry.value) } : { ok: false };
}

const fetcherFor = (status: number, raw: Uint8Array) => async () => ({ status, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer });

async function assertSame(label: string, source: SourceName, body: unknown, status = 200) {
  const raw = bytesOf(body);
  const theirs = workflowOutcome(source, status, raw);
  const mine = await readSource(source, fetcherFor(status, raw));
  assert.equal(mine.ok, theirs.ok, `${label}: plugin ${mine.ok ? "accepts" : `rejects (${mine.reason})`}, workflow ${theirs.ok ? "accepts" : "rejects"}`);
  if (theirs.ok) assert.equal(mine.usd, formatUnits(theirs.value!, 6), label);
  return theirs;
}

const live = () => fixtures.liveBodies;
const h100 = (body: Body) => body.models.find((m: Body) => m.model === "h100" && m.interface === "SXM5");
const sxm = (body: Body) => body.instance_types.filter((l: Body) => l.configuration.interconnect === "sxm5");
const verdaH100 = (body: Body) => body.filter((e: Body) => e?.gpu?.description === "1x H100 SXM5 80GB");
const edit = (source: SourceName, change: (body: Body) => Body | void): Body => { const body = live()[source](); return change(body) ?? body; };

const cases: [string, SourceName, () => unknown][] = [
  ["akash: live capture", "akash", () => live().akash()],
  ["akash: 2 providers is the minimum", "akash", () => edit("akash", (b) => { h100(b).providerAvailability.total = 2; })],
  ["akash: 1 provider", "akash", () => edit("akash", (b) => { h100(b).providerAvailability.total = 1; })],
  ["akash: fractional provider count 2.5", "akash", () => edit("akash", (b) => { h100(b).providerAvailability.total = 2.5; })],
  ["akash: provider count as a string", "akash", () => edit("akash", (b) => { h100(b).providerAvailability.total = "4"; })],
  ["akash: null provider count", "akash", () => edit("akash", (b) => { h100(b).providerAvailability.total = null; })],
  ["akash: currency uakt", "akash", () => edit("akash", (b) => { h100(b).price.currency = "uakt"; })],
  ["akash: no H100 model", "akash", () => edit("akash", (b) => { b.models = b.models.filter((m: Body) => m.model !== "h100"); })],
  ["akash: two matching models", "akash", () => edit("akash", (b) => { b.models.push(structuredClone(h100(b))); })],
  ["akash: malformed unrelated models are ignored", "akash", () => edit("akash", (b) => { b.models.push(null, 7, "x", [], { vendor: "nvidia" }); })],
  ["akash: models is not an array", "akash", () => ({ models: {} })],
  ["akash: array body", "akash", () => []],
  ["akash: string price", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = "2.73"; })],
  ["akash: zero price", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 0; })],
  ["akash: negative price", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = -2.73; })],
  ["akash: exponent-range price 1e-7", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 1e-7; })],
  ["akash: exponent-range price 1e21", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 1e21; })],
  ["akash: digits past the scale are floored", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 2.7399999999; })],
  ["akash: price just under the lower sanity bound", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 0.499999; })],
  ["akash: price at the lower sanity bound", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 0.5; })],
  ["akash: price at the upper sanity bound", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 20; })],
  ["akash: price just over the upper sanity bound", "akash", () => edit("akash", (b) => { h100(b).price.weightedAverage = 20.000001; })],

  ["runpod: live capture", "runpod", () => live().runpod()],
  ["runpod: empty gpuTypes", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes = []; })],
  ["runpod: duplicated gpu type", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes.push(structuredClone(b.data.gpuTypes[0])); })],
  ["runpod: GraphQL error body", "runpod", () => ({ errors: [{ message: "boom" }] })],
  ["runpod: null lowestPrice", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes[0].lowestPrice = null; })],
  ["runpod: string price", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes[0].lowestPrice.uninterruptablePrice = "2.69"; })],
  ["runpod: zero price", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes[0].lowestPrice.uninterruptablePrice = 0; })],
  ["runpod: malformed unrelated entries are ignored", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes.push(null, 7, "x", [], { id: "other" }); })],
  ["runpod: price below the sanity bound", "runpod", () => edit("runpod", (b) => { b.data.gpuTypes[0].lowestPrice.uninterruptablePrice = 0.1; })],

  ["verda: live capture", "verda", () => live().verda()],
  ["verda: not an array", "verda", () => ({ instance_types: [] })],
  ["verda: no matching description", "verda", () => edit("verda", (b) => { verdaH100(b).forEach((e: Body) => { e.gpu.description = "1x H100 PCIe 80GB"; }); })],
  ["verda: non-usd currency", "verda", () => edit("verda", (b) => { verdaH100(b)[0].currency = "eur"; })],
  ["verda: numeric price", "verda", () => edit("verda", (b) => { verdaH100(b)[0].price_per_hour = 4.047; })],
  ["verda: exponent price", "verda", () => edit("verda", (b) => { verdaH100(b)[0].price_per_hour = "4e0"; })],
  ["verda: comma price", "verda", () => edit("verda", (b) => { verdaH100(b)[0].price_per_hour = "4,047"; })],
  ["verda: 12 fraction digits are accepted and floored", "verda", () => edit("verda", (b) => { verdaH100(b).forEach((e: Body) => { e.price_per_hour = "4.047999999999"; }); })],
  ["verda: 13 fraction digits are rejected", "verda", () => edit("verda", (b) => { verdaH100(b)[0].price_per_hour = "4.0479999999999"; })],
  ["verda: ten integer digits are rejected", "verda", () => edit("verda", (b) => { verdaH100(b)[0].price_per_hour = "1234567890"; })],
  ["verda: one malformed matching entry fails the source", "verda", () => edit("verda", (b) => { verdaH100(b)[1].price_per_hour = null; })],
  ["verda: garbage elsewhere is ignored", "verda", () => edit("verda", (b) => { b.push(null, 7, "x", { gpu: null }, { gpu: { description: "1x H100 SXM5 80GB", number_of_gpus: 2 }, price_per_hour: "bad" }); })],
  ["verda: the cheapest of several listings", "verda", () => edit("verda", (b) => { verdaH100(b)[1].price_per_hour = "3.9"; })],

  ["shadeform: live capture", "shadeform", () => live().shadeform()],
  ["shadeform: not an object", "shadeform", () => [live().shadeform()]],
  ["shadeform: listings not an array", "shadeform", () => edit("shadeform", (b) => { b.instance_types = {}; })],
  ["shadeform: too few clouds", "shadeform", () => edit("shadeform", (b) => { b.instance_types = b.instance_types.filter((l: Body) => l.cloud !== "nebius"); })],
  ["shadeform: fractional price", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].hourly_price = 441.5; })],
  ["shadeform: string price", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].hourly_price = "441"; })],
  ["shadeform: zero price", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].hourly_price = 0; })],
  ["shadeform: uppercase cloud name on a matching listing", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].cloud = "Bad Cloud"; })],
  ["shadeform: non-string cloud on a matching listing", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].cloud = 5; })],
  ["shadeform: invalid cloud name on a non-matching listing is ignored", "shadeform", () => edit("shadeform", (b) => { b.instance_types.find((l: Body) => l.configuration.interconnect === "pcie").cloud = "Bad Cloud"; })],
  ["shadeform: cloud name of 33 characters", "shadeform", () => edit("shadeform", (b) => { sxm(b)[0].cloud = "a".repeat(33); })],
  ["shadeform: garbage entries and malformed configuration are ignored", "shadeform", () => edit("shadeform", (b) => { b.instance_types.push(null, 3, "x", { configuration: null }, { configuration: "x" }, { configuration: [] }); })],
  ["shadeform: other gpu types are filtered before price checks", "shadeform", () => edit("shadeform", (b) => {
    const t = structuredClone(b.instance_types[0]);
    b.instance_types.push({ ...t, configuration: { ...t.configuration, gpu_type: "H100_nvl", interconnect: "sxm5" }, hourly_price: "bad" });
  })],
  ["shadeform: verda listing with a bad price is excluded first", "shadeform", () => edit("shadeform", (b) => {
    const t = structuredClone(sxm(b)[0]);
    b.instance_types.push({ ...t, cloud: "verda", hourly_price: "excluded" });
  })],
  ["shadeform: cheapest per cloud", "shadeform", () => edit("shadeform", (b) => { const t = structuredClone(sxm(b)[0]); t.hourly_price = 1; b.instance_types.push(t); })],
];

run("the plugin and the workflow build the same request for every source", () => {
  for (const source of SOURCE_NAMES) {
    const theirs = composite.sourceRequest(source, terms);
    const mine = sourceRequest(source);
    assert.equal(mine.url, theirs.url, source);
    assert.equal(mine.body, theirs.body, source);
    assert.equal(mine.maxBytes, theirs.maxBytes, source);
    assert.equal(mine.method, theirs.body === undefined ? "GET" : "POST", source);
  }
  assert.equal(sourceRequest("verda").maxBytes, 200_000);
  for (const source of ["akash", "runpod", "shadeform"] as const) assert.equal(sourceRequest(source).maxBytes, 65_536);
});

run("the workflow's live captures give the same per-source values and the same composite", async () => {
  const bodies = { akash: live().akash(), runpod: live().runpod(), shadeform: live().shadeform(), verda: live().verda() };
  for (const source of SOURCE_NAMES) {
    const out = await assertSame(`live ${source}`, source, bodies[source]);
    assert.equal(out.value, fixtures.expected[source].value);
  }
  const mine = await fetchComposite(async (url) => {
    const source = SOURCE_NAMES.find((s) => url === sourceRequest(s).url)!;
    const raw = bytesOf(bodies[source]);
    return fetcherFor(200, raw)();
  });
  const theirs = composite.compositeSnapshot(Object.fromEntries(SOURCE_NAMES.map((s) => [s, { ok: true, ...composite.extractSource(s, bodies[s], terms) }])), terms, NOW, "mark");
  assert.equal(mine.validSources, theirs.slots);
  assert.equal(mine.indexUsd, formatUnits(theirs.price, 6));
  assert.equal(mine.indexUsd, "3.3885");
});

for (const [name, source, build] of cases) {
  run(`identical bodies, same verdict: ${name}`, async () => { await assertSame(name, source, build()); });
}

const withPad = (body: object | unknown[], pad: string) => (Array.isArray(body) ? [...body, { pad }] : { ...body, pad });
// A valid body of exactly `size` bytes: padding goes into an ignored field, the remainder into trailing whitespace.
const padTo = (body: object | unknown[], size: number, filler = "x") => {
  const enc = new TextEncoder();
  const base = enc.encode(JSON.stringify(withPad(body, ""))).length;
  const text = JSON.stringify(withPad(body, filler.repeat(Math.floor((size - base) / enc.encode(filler).length))));
  return text + " ".repeat(size - enc.encode(text).length);
};

run("response size is measured in bytes against the workflow's caps: at the cap passes, one byte over fails", async () => {
  for (const source of SOURCE_NAMES) {
    const cap = composite.sourceRequest(source, terms).maxBytes as number;
    const at = padTo(live()[source](), cap);
    const over = padTo(live()[source](), cap + 1);
    assert.equal(bytesOf(at).length, cap);
    assert.equal(bytesOf(over).length, cap + 1);
    assert.equal((await assertSame(`${source} at the cap`, source, at)).ok, true);
    assert.equal((await assertSame(`${source} one byte over`, source, over)).ok, false);
    assert.equal((await readSource(source, fetcherFor(200, bytesOf(over)))).reason, `response exceeds ${cap} bytes`);
  }
});

run("a valid body of 70000 bytes is refused for Akash, RunPod and Shadeform and accepted for Verda, by both", async () => {
  for (const source of ["akash", "runpod", "shadeform"] as const) assert.equal((await assertSame(`${source} 70000`, source, padTo(live()[source](), 70_000))).ok, false);
  assert.equal((await assertSame("verda 70000", "verda", padTo(live().verda(), 70_000))).ok, true);
  assert.equal((await assertSame("verda 200000", "verda", padTo(live().verda(), 200_000))).ok, true);
  assert.equal((await assertSame("verda 200001", "verda", padTo(live().verda(), 200_001))).ok, false);
});

run("multibyte text counts as bytes: fewer characters than the cap but more bytes is refused by both", async () => {
  const body = padTo(live().shadeform(), 65_536 + 3, "€");
  assert.ok(body.length < 65_536);
  assert.ok(bytesOf(body).length > 65_536);
  assert.equal((await assertSame("multibyte shadeform", "shadeform", body)).ok, false);
  assert.equal((await readSource("shadeform", fetcherFor(200, bytesOf(body)))).reason, "response exceeds 65536 bytes");
  const inside = padTo(live().shadeform(), 65_536, "€");
  assert.equal((await assertSame("multibyte shadeform at the cap", "shadeform", inside)).ok, true);
});

run("only HTTP 200 is accepted, as in the workflow", async () => {
  for (const status of [201, 204, 206, 301, 304, 404, 429, 500]) {
    const out = await assertSame(`status ${status}`, "runpod", live().runpod(), status);
    assert.equal(out.ok, false, String(status));
  }
});

run("empty, truncated and non-JSON bodies fail the same way", async () => {
  for (const raw of ["", "{", "not json", "null", "[]", "{\"data\":"]) await assertSame(`body ${JSON.stringify(raw)}`, "runpod", raw);
});

run("the A11 case: a valid Shadeform response padded past the cap leaves both at three sources and the same price", async () => {
  const bodies: Record<SourceName, unknown> = { akash: live().akash(), runpod: live().runpod(), verda: live().verda(), shadeform: padTo(live().shadeform(), 70_000) };
  const mine = await fetchComposite(async (url) => {
    const source = SOURCE_NAMES.find((s) => url === sourceRequest(s).url)!;
    return fetcherFor(200, bytesOf(bodies[source]))();
  });
  const results: Record<string, unknown> = {};
  for (const source of SOURCE_NAMES) {
    const o = workflowOutcome(source, 200, bytesOf(bodies[source]));
    results[source] = o.ok ? good(o.value!, fixtures.expected[source].count) : { ok: false, reason: "response-too-large" };
  }
  const theirs = composite.compositeSnapshot(results, terms, NOW, "mark");
  assert.equal(mine.validSources, 3);
  assert.equal(theirs.slots, 3);
  assert.equal(mine.indexUsd, formatUnits(theirs.price, 6));
  assert.equal(mine.indexUsd, "2.73");
});
