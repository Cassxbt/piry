import { keccak256, toBytes } from "viem";
import { akashQuote, canonicalJson, numberToUnits, selectAkashModel, snapshotTime, type AkashScope } from "./akash.js";
import {
  COMPOSITE_ENDPOINTS, COMPOSITE_METHODOLOGY, COMPOSITE_SOURCES, MAX_RESPONSE_BYTES, decimalUnits, indexIdentity, plainObject,
  requireValue, sanityUnits, validateTerms, type CompositeTerms, type ValidatedMark,
} from "./validation.js";

export type CompositeSource = (typeof COMPOSITE_SOURCES)[number];
export type Observation = { value: bigint; count: number };
export const FAILURE_REASONS = [
  "http-status", "response-too-large", "invalid-response", "outside-sanity-bounds", "below-minimum-count", "unavailable-or-no-consensus",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export type SourceResult = ({ ok: true } & Observation) | { ok: false; reason: FailureReason };
export type SourceRequest = { url: string; body?: string; maxBytes: number };

// The config's source fields carry this label for COMPOSITE: every URL is fixed below, so config cannot redirect a source.
export const COMPOSITE_SOURCE_LABEL = "piry:composite-h100-sxm-median-v1";
const VERDA_MAX_BYTES = 200_000;

export function sourceRequest(source: CompositeSource, terms: CompositeTerms): SourceRequest {
  const rules = terms.sources;
  switch (source) {
    case "akash": return { url: COMPOSITE_ENDPOINTS.akash, maxBytes: MAX_RESPONSE_BYTES };
    case "runpod": return {
      url: COMPOSITE_ENDPOINTS.runpod, maxBytes: MAX_RESPONSE_BYTES,
      body: JSON.stringify({ query: `{ gpuTypes(input:{id:${JSON.stringify(rules.runpod.gpuTypeId)}}) { id lowestPrice(input:{gpuCount:${rules.runpod.gpuCount}}){ uninterruptablePrice } } }` }),
    };
    case "shadeform": return {
      url: `${COMPOSITE_ENDPOINTS.shadeform}?gpu_type=${encodeURIComponent(rules.shadeform.gpuType)}&num_gpus=${rules.shadeform.numGpus}`,
      maxBytes: MAX_RESPONSE_BYTES,
    };
    case "verda": return { url: COMPOSITE_ENDPOINTS.verda, maxBytes: VERDA_MAX_BYTES };
  }
}

// Maps an error message to a fixed reason code so the evidence never carries free text.
export function failureReason(message: string): FailureReason {
  if (/HTTP status/.test(message)) return "http-status";
  if (/response exceeds/.test(message)) return "response-too-large";
  if (/invalid-response|not valid JSON/.test(message)) return "invalid-response";
  return "unavailable-or-no-consensus";
}

const sortBigints = (values: bigint[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// For an even count the median is the floor of the mean of the two middle values.
function median(values: bigint[]): bigint {
  const sorted = sortBigints(values);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function extractRunpod(body: unknown, rule: CompositeTerms["sources"]["runpod"], decimals: number): Observation {
  const { gpuTypes } = plainObject(plainObject(body).data, "data object");
  requireValue(Array.isArray(gpuTypes), "gpuTypes must be an array");
  const matches = gpuTypes.filter(entry => isObject(entry) && entry.id === rule.gpuTypeId);
  requireValue(matches.length === 1, `exactly one gpu type must match, found ${matches.length}`);
  const lowest = plainObject(matches[0].lowestPrice, "lowestPrice object");
  return { value: numberToUnits(lowest.uninterruptablePrice, decimals), count: 1 };
}

// Every entry the rule matches must be well formed, so a bad listing fails the source instead of being skipped;
// the minimum of several matching listings is the on-demand price.
function extractVerda(body: unknown, rule: CompositeTerms["sources"]["verda"], decimals: number): Observation {
  requireValue(Array.isArray(body), "instance types must be an array");
  const matches = body.filter(entry => isObject(entry) && isObject(entry.gpu)
    && entry.gpu.description === rule.gpuDescription && entry.gpu.number_of_gpus === rule.numberOfGpus);
  requireValue(matches.length >= 1, "no instance type matches the rule");
  const prices = matches.map(entry => {
    requireValue(entry.currency === "usd", "price currency must be usd");
    requireValue(typeof entry.price_per_hour === "string" && /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/.test(entry.price_per_hour),
      "price_per_hour must be a plain decimal string");
    return decimalUnits(entry.price_per_hour, decimals, false);
  });
  return { value: sortBigints(prices)[0], count: matches.length };
}

// Cheapest listing per cloud, then the median across clouds. The API quotes integer cents per hour.
function extractShadeform(body: unknown, rule: CompositeTerms["sources"]["shadeform"], decimals: number): Observation {
  const { instance_types: listings } = plainObject(body);
  requireValue(Array.isArray(listings), "instance_types must be an array");
  const cheapest = new Map<string, number>();
  for (const listing of listings) {
    if (!isObject(listing) || !isObject(listing.configuration)) continue;
    const { gpu_type: gpuType, num_gpus: numGpus, interconnect } = listing.configuration;
    if (gpuType !== rule.gpuType || numGpus !== rule.numGpus || (rule.interconnect !== "any" && interconnect !== rule.interconnect)) continue;
    requireValue(typeof listing.cloud === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(listing.cloud), "invalid cloud name");
    if (rule.excludeClouds.includes(listing.cloud)) continue;
    const cents = listing.hourly_price;
    requireValue(typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0, "hourly_price must be positive integer cents");
    cheapest.set(listing.cloud, Math.min(cheapest.get(listing.cloud) ?? cents, cents));
  }
  requireValue(cheapest.size >= rule.minClouds, `${cheapest.size} clouds listed, ${rule.minClouds} required`);
  const units = [...cheapest.values()].map(cents => BigInt(cents) * 10n ** BigInt(decimals) / 100n);
  return { value: median(units), count: cheapest.size };
}

export function extractSource(source: CompositeSource, body: unknown, terms: CompositeTerms): Observation {
  const { sources: rules, priceDecimals: decimals } = terms;
  switch (source) {
    case "akash": {
      const { units, providers } = akashQuote(selectAkashModel(body, rules.akash.selector), rules.akash, decimals);
      return { value: units, count: providers };
    }
    case "runpod": return extractRunpod(body, rules.runpod, decimals);
    case "shadeform": return extractShadeform(body, rules.shadeform, decimals);
    case "verda": return extractVerda(body, rules.verda, decimals);
  }
}

// Per-source requirements the DON re-applies to the agreed observation.
function acceptable(source: CompositeSource, observation: Observation, terms: CompositeTerms): FailureReason | undefined {
  const { min, max } = sanityUnits(terms);
  if (observation.value < min || observation.value > max) return "outside-sanity-bounds";
  const required = source === "akash" ? terms.sources.akash.minProviders : source === "shadeform" ? terms.sources.shadeform.minClouds : 1;
  return Number.isSafeInteger(observation.count) && observation.count >= required ? undefined : "below-minimum-count";
}

type Entry = { ok: true; value: string; count: number } | { ok: false; reason: FailureReason };

export function compositeSnapshot(
  results: Record<CompositeSource, SourceResult>, terms: CompositeTerms, nowSeconds: number, scope: AkashScope,
): ValidatedMark {
  validateTerms(terms);
  const observedAt = snapshotTime(terms, nowSeconds, scope);
  const entries = {} as Record<CompositeSource, Entry>;
  const values: bigint[] = [];
  for (const source of COMPOSITE_SOURCES) {
    const result = results[source];
    const reason = result.ok ? acceptable(source, result, terms) : result.reason;
    if (result.ok && reason === undefined) {
      values.push(result.value);
      entries[source] = { ok: true, value: result.value.toString(), count: result.count };
    } else {
      requireValue((FAILURE_REASONS as readonly unknown[]).includes(reason), "unknown failure reason");
      entries[source] = { ok: false, reason: reason as FailureReason };
    }
  }
  requireValue(values.length >= terms.minSources, `${values.length} valid sources, ${terms.minSources} required`);
  const canonicalEvidence = canonicalJson({
    methodology: COMPOSITE_METHODOLOGY, specHash: indexIdentity(terms).specHash, sources: entries, observedAt,
  });
  return {
    price: median(values), publishedAt: observedAt, evidenceHash: keccak256(toBytes(canonicalEvidence)), canonicalEvidence,
    observedAt, slots: values.length, methodology: COMPOSITE_METHODOLOGY,
  };
}

// Rebuilds the snapshot from the entries inside the evidence, so a mismatch with the terms, the time or the
// canonical form is detected.
export function validateCompositeEvidence(evidence: string, terms: CompositeTerms, nowSeconds: number, scope: AkashScope): ValidatedMark {
  const sources = plainObject(plainObject(JSON.parse(evidence)).sources, "sources object");
  requireValue(Object.keys(sources).length === COMPOSITE_SOURCES.length, "evidence must list every source");
  const results = {} as Record<CompositeSource, SourceResult>;
  for (const source of COMPOSITE_SOURCES) {
    const entry = plainObject(sources[source], "source entry");
    requireValue(entry.ok !== true || (typeof entry.value === "string" && /^[1-9][0-9]{0,77}$/.test(entry.value)), "invalid source value");
    results[source] = entry.ok === true
      ? { ok: true, value: BigInt(entry.value as string), count: entry.count as number }
      : { ok: false, reason: entry.reason as FailureReason };
  }
  const validated = compositeSnapshot(results, terms, nowSeconds, scope);
  requireValue(validated.canonicalEvidence === evidence, "evidence is not canonical for these terms and time");
  return validated;
}
