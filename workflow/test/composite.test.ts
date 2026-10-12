import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { AKASH_SOURCE_URL, canonicalJson } from "../akash.js";
import {
  COMPOSITE_SOURCE_LABEL, compositeSnapshot, extractSource, failureReason, sourceRequest, validateCompositeEvidence,
  type CompositeSource, type SourceResult,
} from "../composite.js";
import { demoTerms } from "../demo.js";
import { encodeMarkReport, encodeMarketReport } from "../report.js";
import { COMPOSITE_METHODOLOGY, COMPOSITE_SOURCES, indexIdentity, validateTerms, type CompositeTerms } from "../validation.js";
import { akashTerms, type Body } from "./akash-fixtures.js";
import { compositeTerms, expected, liveBodies, periodEnd } from "./composite-fixtures.js";

const settleAt = periodEnd + 30;
const markAt = periodEnd - 6 * 3600 + 17;
const SOURCES = [...COMPOSITE_SOURCES];
const ok = (value: bigint, count = 4): SourceResult => ({ ok: true, value, count });
const live = (): Record<CompositeSource, SourceResult> => ({
  akash: ok(expected.akash.value, expected.akash.count), runpod: ok(expected.runpod.value, 1),
  shadeform: ok(expected.shadeform.value, expected.shadeform.count), verda: ok(expected.verda.value, expected.verda.count),
});
const settle = (results = live(), terms: CompositeTerms = compositeTerms, now = settleAt) => compositeSnapshot(results, terms, now, "settlement");
const mark = (results = live(), terms: CompositeTerms = compositeTerms, now = markAt) => compositeSnapshot(results, terms, now, "mark");
const withRule = <K extends CompositeSource>(source: K, change: Partial<CompositeTerms["sources"][K]>): CompositeTerms => ({
  ...compositeTerms, sources: { ...compositeTerms.sources, [source]: { ...compositeTerms.sources[source], ...change } },
});
const extract = (source: CompositeSource, body: unknown, terms = compositeTerms) => extractSource(source, body, terms);

test("composite identity is pinned, deterministic and distinct from DEMO and AKASH", () => {
  const identity = indexIdentity(compositeTerms);
  assert.deepEqual(identity, {
    indexId: "0x9045935a4bec0525c20debad5760c11beea989517893e61455710f500efacbf7",
    specHash: "0x5e66c087d5d9ec7b89d30f6519bb99a80a73bc7c9fde781a691904832ae7020d",
  });
  assert.deepEqual(indexIdentity(structuredClone(compositeTerms)), identity);
  assert.deepEqual(indexIdentity({ ...compositeTerms, periodStart: 1, periodEnd: 2, maxPublicationAgeSeconds: 5 }), identity);
  for (const other of [demoTerms, akashTerms]) {
    assert.notEqual(indexIdentity(other).indexId, identity.indexId);
    assert.notEqual(indexIdentity(other).specHash, identity.specHash);
  }
  assert.equal(indexIdentity({ ...compositeTerms, sanityBounds: { min: "0.5", max: "20" } }).specHash, identity.specHash);
});

test("the spec hash preimage is exactly the rules, the fixed endpoints, the thresholds and the methodology", () => {
  const preimage = '{"schemaVersion":1,"mode":"COMPOSITE","sourceId":"composite-h100-sxm-median","sources":{'
    + '"akash":{"selector":{"vendor":"nvidia","model":"h100","ram":"80Gi","interface":"SXM5"},"priceField":"weightedAverage","minProviders":2},'
    + '"runpod":{"gpuTypeId":"NVIDIA H100 80GB HBM3","gpuCount":1},'
    + '"shadeform":{"gpuType":"H100","numGpus":1,"interconnect":"sxm5","excludeClouds":["verda"],"minClouds":4},'
    + '"verda":{"gpuDescription":"1x H100 SXM5 80GB","numberOfGpus":1}},'
    + '"endpoints":{"akash":"https://console-api.akash.network/v1/gpu-prices","runpod":"https://api.runpod.io/graphql",'
    + '"shadeform":"https://api.shadeform.ai/v1/instances/types","verda":"https://api.verda.com/v1/instance-types"},'
    + '"minSources":3,"sanityBounds":{"min":"500000","max":"20000000"},"priceDecimals":6,"methodology":"composite-median-v1"}';
  assert.equal(indexIdentity(compositeTerms).specHash, keccak256(toBytes(preimage)));
});

test("every selection rule changes the spec hash; the source list fixes the index id", () => {
  const initial = indexIdentity(compositeTerms);
  const variants: CompositeTerms[] = [
    withRule("akash", { priceField: "med" }), withRule("akash", { minProviders: 3 }),
    withRule("akash", { selector: { ...akashTerms.selector, interface: "PCIe" } }),
    withRule("runpod", { gpuTypeId: "NVIDIA H100 PCIe" }), withRule("runpod", { gpuCount: 2 }),
    withRule("shadeform", { gpuType: "H100_nvl" }), withRule("shadeform", { numGpus: 2 }), withRule("shadeform", { interconnect: "any" }),
    withRule("shadeform", { excludeClouds: ["nebius", "verda"] }), withRule("shadeform", { excludeClouds: [] }), withRule("shadeform", { minClouds: 3 }),
    withRule("verda", { gpuDescription: "1x H100 PCIe 80GB" }), withRule("verda", { numberOfGpus: 2 }),
    { ...compositeTerms, minSources: 4 }, { ...compositeTerms, priceDecimals: 5 },
    { ...compositeTerms, sanityBounds: { min: "0.51", max: "20.00" } }, { ...compositeTerms, sanityBounds: { min: "0.50", max: "20.01" } },
  ];
  for (const terms of variants) {
    assert.notEqual(indexIdentity(terms).specHash, initial.specHash);
    assert.equal(indexIdentity(terms).indexId, initial.indexId);
  }
  assert.equal(
    indexIdentity(compositeTerms).indexId,
    keccak256(toBytes(JSON.stringify(["piry-index-v1", "COMPOSITE", "composite-h100-sxm-median", "akash", "runpod", "shadeform", "verda"]))),
  );
});

for (const [name, terms] of [
  ["a foreign source id", { ...compositeTerms, sourceId: "other" }],
  ["two sources required", { ...compositeTerms, minSources: 2 }],
  ["more sources than exist", { ...compositeTerms, minSources: 5 }],
  ["a missing source rule", { ...compositeTerms, sources: { akash: compositeTerms.sources.akash, runpod: compositeTerms.sources.runpod, verda: compositeTerms.sources.verda } }],
  ["an extra source rule", { ...compositeTerms, sources: { ...compositeTerms.sources, extra: {} } }],
  ["an extra rule field", withRule("runpod", { extra: true } as never)],
  ["zero gpus", withRule("runpod", { gpuCount: 0 })],
  ["an unsorted exclusion list", withRule("shadeform", { excludeClouds: ["verda", "nebius"] })],
  ["a duplicate exclusion", withRule("shadeform", { excludeClouds: ["verda", "verda"] })],
  ["an uppercase exclusion", withRule("shadeform", { excludeClouds: ["Verda"] })],
  ["too many exclusions", withRule("shadeform", { excludeClouds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })],
  ["zero required clouds", withRule("shadeform", { minClouds: 0 })],
  ["an invalid label", withRule("verda", { gpuDescription: "" })],
  ["an unknown akash price field", withRule("akash", { priceField: "avg" as never })],
  ["zero akash providers", withRule("akash", { minProviders: 0 })],
  ["an inverted sanity range", { ...compositeTerms, sanityBounds: { min: "20.00", max: "0.50" } }],
  ["an empty period", { ...compositeTerms, periodEnd: compositeTerms.periodStart }],
  ["a foreign mode", { ...compositeTerms, mode: "LIVE" }],
] as const) {
  test(`composite terms reject ${name}`, () => {
    assert.throws(() => validateTerms(terms as unknown as CompositeTerms));
    assert.throws(() => indexIdentity(terms as unknown as CompositeTerms));
  });
}

test("every source URL is fixed, HTTPS and derived only from the rules", () => {
  const requests = Object.fromEntries(SOURCES.map(source => [source, sourceRequest(source, compositeTerms)]));
  assert.equal(requests.akash.url, AKASH_SOURCE_URL);
  assert.equal(requests.runpod.url, "https://api.runpod.io/graphql");
  assert.equal(requests.verda.url, "https://api.verda.com/v1/instance-types");
  assert.equal(requests.shadeform.url, "https://api.shadeform.ai/v1/instances/types?gpu_type=H100&num_gpus=1");
  for (const request of Object.values(requests)) assert.match(request.url, /^https:\/\//);
  for (const source of ["akash", "verda", "shadeform"]) assert.equal(requests[source].body, undefined);
  assert.deepEqual(JSON.parse(requests.runpod.body!), {
    query: '{ gpuTypes(input:{id:"NVIDIA H100 80GB HBM3"}) { id lowestPrice(input:{gpuCount:1}){ uninterruptablePrice } } }',
  });
  assert.equal(sourceRequest("shadeform", withRule("shadeform", { gpuType: "H100_nvl", numGpus: 2 })).url,
    "https://api.shadeform.ai/v1/instances/types?gpu_type=H100_nvl&num_gpus=2");
  assert.equal(requests.verda.maxBytes, 200_000);
  for (const source of ["akash", "runpod", "shadeform"]) assert.equal(requests[source].maxBytes, 65536);
  assert.notEqual(COMPOSITE_SOURCE_LABEL, "");
});

test("live captures extract to the expected integer values and counts", () => {
  for (const source of SOURCES) {
    assert.deepEqual(extract(source, liveBodies[source]()), { value: expected[source].value, count: expected[source].count }, source);
  }
});

const mutate = (source: CompositeSource, change: (body: Body) => Body | void) => {
  const body = liveBodies[source]();
  return change(body) ?? body;
};
const runpodEntry = (body: Body) => body.data.gpuTypes[0];
const verdaH100 = (body: Body) => body.filter((entry: Body) => entry?.gpu?.description === "1x H100 SXM5 80GB");
const sxm = (body: Body) => body.instance_types.filter((listing: Body) => listing.configuration.interconnect === "sxm5");

for (const [source, name, change, pattern] of [
  ["runpod", "an empty gpuTypes list", (b: Body) => { b.data.gpuTypes = []; }, /exactly one/],
  ["runpod", "a different gpu type id", (b: Body) => { runpodEntry(b).id = "NVIDIA H100 PCIe"; }, /exactly one/],
  ["runpod", "a duplicated gpu type", (b: Body) => { b.data.gpuTypes.push(structuredClone(runpodEntry(b))); }, /exactly one/],
  ["runpod", "a GraphQL error body", (b: Body) => { delete b.data; b.errors = [{ message: "boom" }]; }, /data/],
  ["runpod", "null data", (b: Body) => { b.data = null; }, /data/],
  ["runpod", "a null lowestPrice", (b: Body) => { runpodEntry(b).lowestPrice = null; }, /lowestPrice/],
  ["runpod", "a null price", (b: Body) => { runpodEntry(b).lowestPrice.uninterruptablePrice = null; }, /price/],
  ["runpod", "a zero price", (b: Body) => { runpodEntry(b).lowestPrice.uninterruptablePrice = 0; }, /price/],
  ["runpod", "a negative price", (b: Body) => { runpodEntry(b).lowestPrice.uninterruptablePrice = -2.69; }, /price/],
  ["runpod", "a string price", (b: Body) => { runpodEntry(b).lowestPrice.uninterruptablePrice = "2.69"; }, /price/],
  ["verda", "a non-array body", (b: Body) => ({ instance_types: b }), /array/],
  ["verda", "no matching description", (b: Body) => { verdaH100(b).forEach((entry: Body) => { entry.gpu.description = "1x H100 PCIe 80GB"; }); }, /no instance type/],
  ["verda", "no single-gpu entry", (b: Body) => { verdaH100(b).forEach((entry: Body) => { entry.gpu.number_of_gpus = 2; }); }, /no instance type/],
  ["verda", "a non-usd currency", (b: Body) => { verdaH100(b)[0].currency = "eur"; }, /currency/],
  ["verda", "a numeric price", (b: Body) => { verdaH100(b)[0].price_per_hour = 4.047; }, /decimal string/],
  ["verda", "a comma price", (b: Body) => { verdaH100(b)[0].price_per_hour = "4,047"; }, /decimal string/],
  ["verda", "a negative price", (b: Body) => { verdaH100(b)[0].price_per_hour = "-4.047"; }, /decimal string/],
  ["verda", "an exponent price", (b: Body) => { verdaH100(b)[0].price_per_hour = "4e0"; }, /decimal string/],
  ["verda", "one malformed matching entry", (b: Body) => { verdaH100(b)[1].price_per_hour = null; }, /decimal string/],
  ["shadeform", "a non-object body", (b: Body) => [b], /schema|object/],
  ["shadeform", "no listings array", (b: Body) => { b.instance_types = {}; }, /array/],
  ["shadeform", "too few clouds", (b: Body) => { b.instance_types = b.instance_types.filter((l: Body) => l.cloud !== "nebius"); }, /clouds listed/],
  ["shadeform", "a fractional price", (b: Body) => { sxm(b)[0].hourly_price = 441.5; }, /cents/],
  ["shadeform", "a string price", (b: Body) => { sxm(b)[0].hourly_price = "441"; }, /cents/],
  ["shadeform", "a zero price", (b: Body) => { sxm(b)[0].hourly_price = 0; }, /cents/],
  ["shadeform", "a negative price", (b: Body) => { sxm(b)[0].hourly_price = -441; }, /cents/],
  ["shadeform", "an invalid cloud name", (b: Body) => { sxm(b)[0].cloud = "Bad Cloud"; }, /cloud/],
] as const) {
  test(`${source} extraction rejects ${name}`, () => {
    assert.throws(() => extract(source, mutate(source, change)), pattern);
  });
}

test("akash extraction applies the existing model checks and minimum providers", () => {
  for (const [change, pattern] of [
    [(b: Body) => { b.models.find((m: Body) => m.model === "h100" && m.interface === "SXM5").providerAvailability.total = 1; }, /provider/],
    [(b: Body) => { b.models.find((m: Body) => m.model === "h100" && m.interface === "SXM5").price.currency = "uakt"; }, /currency/],
    [(b: Body) => { b.models = b.models.filter((m: Body) => m.model !== "h100"); }, /exactly one/],
  ] as const) assert.throws(() => extract("akash", mutate("akash", change)), pattern);
});

test("verda: several single-gpu listings use the minimum price and are all counted", () => {
  const body = liveBodies.verda();
  verdaH100(body)[1].price_per_hour = "3.9";
  assert.deepEqual(extract("verda", body), { value: 3900000n, count: 2 });
  const extra = structuredClone(verdaH100(body)[0]);
  extra.instance_type = "1H100.80S.99V";
  extra.price_per_hour = "5.5";
  body.push(extra);
  assert.deepEqual(extract("verda", body), { value: 3900000n, count: 3 });
});

test("verda: listings of other products and garbage elsewhere are ignored; prices floor to the scale", () => {
  const body = liveBodies.verda();
  const h100 = verdaH100(body);
  body.push(null, 7, "x", { gpu: null }, { gpu: { description: "1x H100 SXM5 80GB", number_of_gpus: 2 }, price_per_hour: "bad" });
  assert.deepEqual(extract("verda", body), { value: 4047000n, count: 2 });
  h100.forEach((entry: Body) => { entry.price_per_hour = "4.0479999"; });
  assert.equal(extract("verda", body).value, 4047999n);
});

test("shadeform: cheapest listing per cloud, then the median across clouds", () => {
  const body = liveBodies.shadeform();
  const cheapest = (terms: CompositeTerms) => extract("shadeform", body, terms);
  assert.deepEqual(cheapest(compositeTerms), { value: 4170000n, count: 4 });
  assert.deepEqual(cheapest(withRule("shadeform", { excludeClouds: [], minClouds: 5 })), { value: 3980000n, count: 5 });
  const any = withRule("shadeform", { interconnect: "any", excludeClouds: [], minClouds: 1 });
  assert.deepEqual(cheapest(any), { value: 3300000n, count: 11 });
  assert.deepEqual(cheapest(withRule("shadeform", { interconnect: "any", excludeClouds: ["verda"], minClouds: 1 })), { value: 3015000n, count: 10 });
  const lambda = body.instance_types.filter((listing: Body) => listing.cloud === "lambdalabs");
  assert.deepEqual(lambda.map((listing: Body) => [listing.configuration.interconnect, listing.hourly_price]).sort(), [["pcie", 429], ["sxm5", 436]]);
  const four = structuredClone(body);
  four.instance_types = four.instance_types.filter((listing: Body) => listing.cloud !== "voltagepark");
  assert.deepEqual(extract("shadeform", four, withRule("shadeform", { excludeClouds: [], minClouds: 4 })), { value: 4170000n, count: 4 });
  const odd = structuredClone(four);
  odd.instance_types = odd.instance_types.filter((listing: Body) => listing.cloud !== "digitalocean");
  assert.deepEqual(extract("shadeform", odd, withRule("shadeform", { excludeClouds: [], minClouds: 3 })), { value: 3980000n, count: 3 });
});

test("shadeform: other gpu types, gpu counts and excluded clouds are filtered before price checks", () => {
  const body = liveBodies.shadeform();
  const template = structuredClone(body.instance_types[0]);
  body.instance_types.push(
    { ...structuredClone(template), configuration: { ...template.configuration, gpu_type: "H100_nvl", interconnect: "sxm5" }, hourly_price: "bad" },
    { ...structuredClone(template), configuration: { ...template.configuration, num_gpus: 8, interconnect: "sxm5" }, hourly_price: -1 },
    { ...structuredClone(template), cloud: "verda", configuration: { ...template.configuration, interconnect: "sxm5" }, hourly_price: "excluded" },
    null, 3, { configuration: null },
  );
  assert.deepEqual(extract("shadeform", body), { value: 4170000n, count: 4 });
});

test("shadeform: the cheapest of several listings from one cloud counts, not the first or the dearest", () => {
  const listing = (cloud: string, cents: number) => ({ cloud, hourly_price: cents, configuration: { gpu_type: "H100", num_gpus: 1, interconnect: "sxm5" } });
  const terms = withRule("shadeform", { minClouds: 3 });
  const dearFirst = { instance_types: [listing("a", 900), listing("a", 100), listing("b", 400), listing("b", 800), listing("c", 500)] };
  const cheapFirst = { instance_types: [listing("a", 100), listing("a", 900), listing("b", 800), listing("b", 400), listing("c", 500)] };
  assert.deepEqual(extract("shadeform", dearFirst, terms), { value: 4000000n, count: 3 });
  assert.deepEqual(extract("shadeform", cheapFirst, terms), { value: 4000000n, count: 3 });
});

test("shadeform: cents convert to the price scale without float arithmetic", () => {
  const exact = { instance_types: ["a", "b", "c", "d"].map(cloud => ({
    cloud, hourly_price: 99999, configuration: { gpu_type: "H100", num_gpus: 1, interconnect: "sxm5" },
  })) };
  assert.equal(extract("shadeform", exact, { ...compositeTerms, priceDecimals: 18 }).value, 99999n * 10n ** 16n);
  const body = { instance_types: ["a", "b", "c", "d"].map((cloud, index) => ({
    cloud, hourly_price: 333 + index, configuration: { gpu_type: "H100", num_gpus: 1, interconnect: "sxm5" },
  })) };
  assert.deepEqual(extract("shadeform", body), { value: 3345000n, count: 4 });
  assert.equal(extract("shadeform", body, { ...compositeTerms, priceDecimals: 2 }).value, 334n);
  assert.equal(extract("shadeform", body, { ...compositeTerms, priceDecimals: 0 }).value, 3n);
});

test("composite is the median of the valid sources: floor of the mean of the middle pair for an even count", () => {
  const result = settle();
  assert.equal(result.price, expected.median);
  assert.equal(result.slots, 4);
  assert.equal(result.methodology, COMPOSITE_METHODOLOGY);
  assert.equal(result.publishedAt, settleAt - 30);
  assert.equal(result.observedAt, result.publishedAt);
  assert.equal(result.evidenceHash, keccak256(toBytes(result.canonicalEvidence)));
  const odd = live();
  odd.shadeform = { ok: false, reason: "invalid-response" };
  assert.equal(settle(odd).price, 2730000n);
  assert.equal(settle(odd).slots, 3);
  const flooring = live();
  flooring.akash = ok(2000001n);
  flooring.runpod = ok(2000002n, 1);
  flooring.shadeform = ok(9000000n);
  flooring.verda = ok(9000001n, 1);
  assert.equal(settle(flooring).price, (2000002n + 9000000n) / 2n);
  assert.equal(settle(flooring).price, 5500001n);
});

test("one outlier source cannot move the median beyond the middle pair", () => {
  const results = live();
  results.verda = ok(19990000n, 2);
  assert.equal(settle(results).price, (2730000n + 4170000n) / 2n);
  results.runpod = ok(500000n, 1);
  assert.equal(settle(results).price, (2730000n + 4170000n) / 2n);
});

test("failed sources are recorded in the evidence with a reason, never dropped", () => {
  const results = live();
  results.runpod = { ok: false, reason: "http-status" };
  const evidence = JSON.parse(settle(results).canonicalEvidence);
  assert.deepEqual(evidence.sources.runpod, { ok: false, reason: "http-status" });
  assert.deepEqual(Object.keys(evidence.sources), SOURCES);
  assert.deepEqual(evidence.sources.akash, { count: 4, ok: true, value: "2730000" });
});

test("fewer than the required valid sources fails closed", () => {
  const results = live();
  results.runpod = { ok: false, reason: "http-status" };
  results.verda = { ok: false, reason: "unavailable-or-no-consensus" };
  assert.throws(() => settle(results), /2 valid sources, 3 required/);
});

test("a source outside the sanity bounds or below its minimum count is recorded as failed", () => {
  const cases: [CompositeSource, SourceResult, string][] = [
    ["runpod", ok(499999n, 1), "outside-sanity-bounds"], ["runpod", ok(20000001n, 1), "outside-sanity-bounds"],
    ["runpod", ok(0n, 1), "outside-sanity-bounds"], ["akash", ok(2730000n, 1), "below-minimum-count"],
    ["shadeform", ok(4170000n, 3), "below-minimum-count"], ["verda", ok(4047000n, 0), "below-minimum-count"],
    ["runpod", ok(2690000n, 0), "below-minimum-count"], ["runpod", ok(2690000n, 1.5), "below-minimum-count"],
  ];
  for (const [source, result, reason] of cases) {
    const results = live();
    results[source] = result;
    const evidence = JSON.parse(settle(results).canonicalEvidence);
    assert.deepEqual(evidence.sources[source], { ok: false, reason }, `${source} ${reason}`);
    assert.equal(settle(results).slots, 3);
  }
  for (const [source, edge] of [["runpod", 500000n], ["runpod", 20000000n]] as const) {
    const results = live();
    results[source] = ok(edge, 1);
    assert.equal(JSON.parse(settle(results).canonicalEvidence).sources[source].ok, true);
  }
});

test("unknown failure reasons are refused", () => {
  const results = live();
  results.runpod = { ok: false, reason: "because I said so" as never };
  assert.throws(() => settle(results), /reason/);
});

test("settlement follows the AKASH snapshot window; marks have none", () => {
  assert.throws(() => settle(live(), compositeTerms, periodEnd - 1), /settlement/);
  assert.equal(settle(live(), compositeTerms, periodEnd).publishedAt, periodEnd);
  assert.equal(settle(live(), compositeTerms, periodEnd + 3600).price, expected.median);
  assert.throws(() => settle(live(), compositeTerms, periodEnd + 3601), /settlement/);
  const offGrid = { ...compositeTerms, periodEnd: periodEnd + 20 };
  assert.throws(() => settle(live(), offGrid, periodEnd + 30), /settlement/);
  assert.equal(settle(live(), offGrid, periodEnd + 60).publishedAt, periodEnd + 60);
  for (const now of [compositeTerms.periodStart - 86400, periodEnd, periodEnd + 100000]) assert.equal(mark(live(), compositeTerms, now).price, expected.median);
});

test("evidence is canonical: sorted keys, minute-floored time, bound to the spec hash", () => {
  const result = mark();
  const evidence = JSON.parse(result.canonicalEvidence);
  assert.deepEqual(Object.keys(evidence), ["methodology", "observedAt", "sources", "specHash"]);
  assert.equal(evidence.methodology, "composite-median-v1");
  assert.equal(evidence.specHash, indexIdentity(compositeTerms).specHash);
  assert.equal(evidence.observedAt, markAt - 17);
  assert.equal(result.canonicalEvidence, canonicalJson(evidence));
  assert.equal(mark(live(), compositeTerms, markAt - 17 + 59).canonicalEvidence, result.canonicalEvidence);
  assert.notEqual(mark(live(), compositeTerms, markAt - 17 + 60).evidenceHash, result.evidenceHash);
});

test("evidence re-validates under the same terms and rejects any inconsistency", () => {
  const settlement = settle();
  assert.deepEqual(validateCompositeEvidence(settlement.canonicalEvidence, compositeTerms, settleAt, "settlement"), settlement);
  const evidence = JSON.parse(settlement.canonicalEvidence);
  const reject = (change: (e: Body) => void, pattern: RegExp, terms = compositeTerms, now = settleAt) => {
    const tampered = structuredClone(evidence);
    change(tampered);
    assert.throws(() => validateCompositeEvidence(JSON.stringify(tampered), terms, now, "settlement"), pattern);
  };
  reject(e => { e.methodology = "other"; }, /canonical/);
  reject(e => { e.specHash = `0x${"11".repeat(32)}`; }, /canonical/);
  reject(e => { e.observedAt += 60; }, /canonical/);
  reject(e => { e.extra = 1; }, /canonical/);
  reject(e => { e.sources.runpod.extra = 1; }, /canonical/);
  reject(e => { e.sources.runpod.value = "499999"; }, /canonical/);
  reject(e => { e.sources.runpod.count = 0; }, /canonical/);
  reject(e => { e.sources.akash.count = 1; }, /canonical/);
  reject(e => { e.sources.runpod = { ok: false, reason: "free text" }; }, /reason/);
  reject(e => { delete e.sources.verda; }, /every source|source entry/);
  reject(e => { e.sources.extra = { ok: false, reason: "http-status" }; }, /every source/);
  reject(e => { e.sources.runpod.value = "02690000"; }, /source value/);
  reject(e => { e.sources.runpod.value = 2690000; }, /source value/);
  reject(e => { e.sources.runpod.value = "0"; }, /source value/);
  reject(e => { e.sources.runpod.ok = "true"; }, /reason/);
  reject(e => { e.sources = []; }, /sources/);
  reject(() => {}, /settlement/, compositeTerms, periodEnd - 1);
  reject(() => {}, /canonical/, withRule("runpod", { gpuCount: 2 }));
  reject(() => {}, /canonical/, { ...compositeTerms, sanityBounds: { min: "0.50", max: "4.10" } });
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(evidence).reverse()));
  assert.throws(() => validateCompositeEvidence(reordered, compositeTerms, settleAt, "settlement"), /canonical/);
  assert.throws(() => validateCompositeEvidence("{", compositeTerms, settleAt, "settlement"));
  assert.throws(() => validateCompositeEvidence("[]", compositeTerms, settleAt, "settlement"), /schema|object/);
});

test("failure reasons are fixed codes derived from the error text", () => {
  assert.equal(failureReason("[2]Unknown: source HTTP status 503"), "http-status");
  assert.equal(failureReason("source response exceeds 200000 bytes"), "response-too-large");
  assert.equal(failureReason("[2]Unknown: invalid-response: 4 clouds listed, 9 required"), "invalid-response");
  assert.equal(failureReason("source response is not valid JSON"), "invalid-response");
  assert.equal(failureReason("anything else, with node-specific 0xdeadbeef text"), "unavailable-or-no-consensus");
});

const settlementDestination = { market: "0x1111111111111111111111111111111111111111" as const, chainId: 10143n };
const markDestination = { feed: "0x3333333333333333333333333333333333333333" as const, chainId: 10143n };

test("composite reports use the existing layouts and bind the composite identity", () => {
  const result = settle();
  const payload = encodeMarketReport(result, compositeTerms, settlementDestination);
  assert.equal((payload.length - 2) / 2, 320);
  const decoded = decodeAbiParameters(parseAbiParameters(
    "address,uint256,bytes32,bytes32,uint8,uint64,uint64,uint256,uint64,bytes32"), payload);
  const identity = indexIdentity(compositeTerms);
  assert.deepEqual(decoded, [settlementDestination.market, 10143n, identity.indexId, identity.specHash, 6,
    BigInt(compositeTerms.periodStart), BigInt(periodEnd), expected.median, BigInt(periodEnd), result.evidenceHash]);

  const marked = mark();
  const markPayload = encodeMarkReport(marked, compositeTerms, markDestination, 15);
  assert.equal((markPayload.length - 2) / 2, 192);
  assert.deepEqual(
    decodeAbiParameters(parseAbiParameters("address,uint256,bytes32,uint256,uint64,bytes32"), markPayload),
    [markDestination.feed, 10143n, identity.indexId, expected.median, BigInt(marked.observedAt - 15), marked.evidenceHash],
  );
});

test("composite reports cannot relabel validated evidence, price, terms or time", () => {
  const result = settle();
  assert.throws(() => encodeMarketReport({ ...result, price: 1n }, compositeTerms, settlementDestination), /evidence|binding/);
  assert.throws(() => encodeMarketReport({ ...result, evidenceHash: `0x${"aa".repeat(32)}` }, compositeTerms, settlementDestination), /evidence|binding/);
  assert.throws(() => encodeMarketReport(result, withRule("shadeform", { minClouds: 3 }), settlementDestination), /evidence|binding/);
  assert.throws(() => encodeMarketReport({ ...result, publishedAt: result.publishedAt + 60 }, compositeTerms, settlementDestination), /evidence|binding|settlement/);
  const early = mark(live(), compositeTerms, periodEnd - 3600);
  assert.throws(() => encodeMarketReport(early, compositeTerms, settlementDestination), /settlement/);
  assert.throws(() => encodeMarkReport({ ...early, observedAt: early.observedAt + 1 }, compositeTerms, markDestination), /evidence|binding/);
  assert.throws(() => encodeMarketReport(result, { ...compositeTerms, mode: "LIVE" } as never, settlementDestination));
});
