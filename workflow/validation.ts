import { keccak256, toBytes, type Hex } from "viem";

export const METHODOLOGY = "equal-slot-mean-floor-v1";
export const SPOT_METHODOLOGY = "pre-period-spot-v1";
export const MAX_SLOTS = 168;
export const UINT256_MAX = (1n << 256n) - 1n;
export const MAX_PRICE = UINT256_MAX / BigInt(MAX_SLOTS);
export const MAX_RESPONSE_BYTES = 65536;
export const AKASH_SOURCE_ID = "akash-console-gpu-prices";
export const AKASH_METHODOLOGY = "akash-console-snapshot-v1";
export const AKASH_PRICE_FIELDS = ["weightedAverage", "med"] as const;
export const COMPOSITE_SOURCE_ID = "composite-h100-sxm-median";
export const COMPOSITE_METHODOLOGY = "composite-median-v1";
export const COMPOSITE_SOURCES = ["akash", "runpod", "shadeform", "verda"] as const;
export const AKASH_SOURCE_URL = "https://console-api.akash.network/v1/gpu-prices";
// Bound into the composite spec hash, so pointing a source anywhere else is a different index.
export const COMPOSITE_ENDPOINTS = {
  akash: AKASH_SOURCE_URL,
  runpod: "https://api.runpod.io/graphql",
  shadeform: "https://api.shadeform.ai/v1/instances/types",
  verda: "https://api.verda.com/v1/instance-types",
} as const;

export type Hardware = { model: string; memoryGiB: number; gpuCount: number; region: string };
export type IndexTerms = {
  mode: "DEMO";
  sourceId: string;
  datasetId: string;
  hardware: Hardware;
  currency: "USD";
  units: "USD/GPU-hour";
  priceDecimals: number;
  slotSeconds: number;
  periodStart: number;
  periodEnd: number;
  maxPublicationAgeSeconds: number;
};
export type AkashSelector = { vendor: string; model: string; ram: string; interface: string };
export type AkashRule = {
  selector: AkashSelector;
  priceField: (typeof AKASH_PRICE_FIELDS)[number];
  minProviders: number;
};
export type AkashTerms = AkashRule & {
  mode: "AKASH";
  sourceId: typeof AKASH_SOURCE_ID;
  sanityBounds: { min: string; max: string };
  priceDecimals: number;
  periodStart: number;
  periodEnd: number;
  maxPublicationAgeSeconds: number;
};
export type CompositeRules = {
  akash: AkashRule;
  runpod: { gpuTypeId: string; gpuCount: number };
  shadeform: { gpuType: string; numGpus: number; interconnect: string; excludeClouds: string[]; minClouds: number };
  verda: { gpuDescription: string; numberOfGpus: number };
};
export type CompositeTerms = {
  mode: "COMPOSITE";
  sourceId: typeof COMPOSITE_SOURCE_ID;
  sources: CompositeRules;
  minSources: number;
  sanityBounds: { min: string; max: string };
  priceDecimals: number;
  periodStart: number;
  periodEnd: number;
  maxPublicationAgeSeconds: number;
};
export type SnapshotTerms = AkashTerms | CompositeTerms;
export type AnyTerms = IndexTerms | SnapshotTerms;
export type ValidatedIndex = {
  price: bigint;
  publishedAt: number;
  evidenceHash: Hex;
  canonicalEvidence: string;
};
export type ValidatedMark = ValidatedIndex & { observedAt: number; slots: number; methodology: string };
type Scope = "full" | "to-date" | "spot";

export function requireValue(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function plainObject(value: unknown, name = "schema object"): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), `invalid ${name}`);
  return value as Record<string, unknown>;
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  const object = plainObject(value);
  const keys = Object.keys(object);
  requireValue(keys.length === fields.length && fields.every(key => Object.hasOwn(object, key)), "invalid schema fields");
  return object;
}

export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be a bounded safe integer`);
  return value;
}

function label(value: unknown, name: string): string {
  requireValue(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value), `${name} invalid label`);
  return value;
}

function hardware(value: unknown): Hardware {
  const data = record(value, ["model", "memoryGiB", "gpuCount", "region"]);
  return {
    model: label(data.model, "model"),
    memoryGiB: integer(data.memoryGiB, "memoryGiB", 1, 2048),
    gpuCount: integer(data.gpuCount, "gpuCount", 1, 16),
    region: label(data.region, "region"),
  };
}

// Scales a plain or exponent decimal string to integer units. Excess digits are floored unless exact is set.
export function decimalUnits(text: string, decimals: number, exact: boolean): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/.exec(text);
  requireValue(match !== null, "invalid decimal");
  const [, whole, fraction = "", exponent = "0"] = match;
  const shift = Number(exponent) + decimals - fraction.length;
  const digits = BigInt(whole + fraction);
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  requireValue(!exact || digits % divisor === 0n, "decimal has more digits than the price scale");
  return digits / divisor;
}

export function sanityUnits({ sanityBounds, priceDecimals }: SnapshotTerms): { min: bigint; max: bigint } {
  const bound = (value: unknown, name: string) => {
    requireValue(typeof value === "string" && /^(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/.test(value), `sanity ${name} must be a plain decimal string`);
    return decimalUnits(value, priceDecimals, true);
  };
  const { min, max } = record(sanityBounds, ["min", "max"]);
  return { min: bound(min, "min"), max: bound(max, "max") };
}

function akashSelector(value: unknown): AkashSelector {
  const data = record(value, ["vendor", "model", "ram", "interface"]);
  return {
    vendor: label(data.vendor, "vendor"), model: label(data.model, "model"),
    ram: label(data.ram, "ram"), interface: label(data.interface, "interface"),
  };
}

function validateAkashRule(rule: AkashRule): void {
  akashSelector(rule.selector);
  requireValue((AKASH_PRICE_FIELDS as readonly unknown[]).includes(rule.priceField), "unsupported price field");
  integer(rule.minProviders, "minProviders", 1, 1000);
}

function validateSnapshotWindow(terms: SnapshotTerms): void {
  integer(terms.priceDecimals, "priceDecimals", 0, 18);
  integer(terms.periodStart, "periodStart");
  integer(terms.periodEnd, "periodEnd");
  integer(terms.maxPublicationAgeSeconds, "maxPublicationAgeSeconds", 1, 86400);
  requireValue(terms.periodEnd > terms.periodStart, "period must be non-empty");
  const { min, max } = sanityUnits(terms);
  requireValue(min > 0n && min < max, "sanity bounds must satisfy 0 < min < max");
}

function validateAkashTerms(terms: AkashTerms): void {
  requireValue(terms.sourceId === AKASH_SOURCE_ID, "unsupported index binding");
  validateAkashRule(terms);
  validateSnapshotWindow(terms);
}

const CLOUD = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function validateCompositeTerms(terms: CompositeTerms): void {
  requireValue(terms.sourceId === COMPOSITE_SOURCE_ID, "unsupported index binding");
  const sources = record(terms.sources, [...COMPOSITE_SOURCES]);
  validateAkashRule(record(sources.akash, ["selector", "priceField", "minProviders"]) as AkashRule);
  const runpod = record(sources.runpod, ["gpuTypeId", "gpuCount"]);
  label(runpod.gpuTypeId, "gpuTypeId");
  integer(runpod.gpuCount, "gpuCount", 1, 8);
  const shadeform = record(sources.shadeform, ["gpuType", "numGpus", "interconnect", "excludeClouds", "minClouds"]);
  label(shadeform.gpuType, "gpuType");
  integer(shadeform.numGpus, "numGpus", 1, 8);
  label(shadeform.interconnect, "interconnect");
  integer(shadeform.minClouds, "minClouds", 1, 32);
  const excluded = shadeform.excludeClouds;
  requireValue(Array.isArray(excluded) && excluded.length <= 8
    && excluded.every((cloud, index) => typeof cloud === "string" && CLOUD.test(cloud) && (index === 0 || excluded[index - 1] < cloud)),
  "excludeClouds must be sorted, unique cloud names");
  const verda = record(sources.verda, ["gpuDescription", "numberOfGpus"]);
  label(verda.gpuDescription, "gpuDescription");
  integer(verda.numberOfGpus, "numberOfGpus", 1, 8);
  integer(terms.minSources, "minSources", 3, COMPOSITE_SOURCES.length);
  validateSnapshotWindow(terms);
}

export function validateTerms(terms: AnyTerms): void {
  if (terms.mode === "AKASH") return validateAkashTerms(terms);
  if (terms.mode === "COMPOSITE") return validateCompositeTerms(terms);
  requireValue(terms.mode === "DEMO" && terms.currency === "USD" && terms.units === "USD/GPU-hour", "unsupported index binding");
  label(terms.sourceId, "sourceId");
  label(terms.datasetId, "datasetId");
  hardware(terms.hardware);
  integer(terms.priceDecimals, "priceDecimals", 0, 18);
  integer(terms.slotSeconds, "slotSeconds", 1, 86400);
  integer(terms.periodStart, "periodStart");
  integer(terms.periodEnd, "periodEnd");
  integer(terms.maxPublicationAgeSeconds, "maxPublicationAgeSeconds", 1, 86400);
  const duration = terms.periodEnd - terms.periodStart;
  requireValue(duration > 0 && duration % terms.slotSeconds === 0 && duration / terms.slotSeconds <= MAX_SLOTS,
    "period must contain 1..168 complete slots");
}

function specification(terms: IndexTerms) {
  return {
    schemaVersion: 1, mode: terms.mode, sourceId: terms.sourceId, datasetId: terms.datasetId,
    hardware: hardware(terms.hardware), currency: terms.currency, units: terms.units,
    priceDecimals: terms.priceDecimals, slotSeconds: terms.slotSeconds, methodology: METHODOLOGY,
  };
}

function akashIdentity(terms: AkashTerms): { indexId: Hex; specHash: Hex } {
  const { vendor, model, ram, interface: connector } = terms.selector;
  const { min, max } = sanityUnits(terms);
  return {
    indexId: keccak256(toBytes(JSON.stringify(["piry-index-v1", terms.mode, terms.sourceId, vendor, model, ram, connector, terms.priceField]))),
    specHash: keccak256(toBytes(JSON.stringify({
      schemaVersion: 1, mode: terms.mode, sourceId: terms.sourceId, selector: { vendor, model, ram, interface: connector },
      priceField: terms.priceField, minProviders: terms.minProviders,
      sanityBounds: { min: min.toString(), max: max.toString() },
      priceDecimals: terms.priceDecimals, methodology: AKASH_METHODOLOGY,
    }))),
  };
}

function compositeIdentity(terms: CompositeTerms): { indexId: Hex; specHash: Hex } {
  const { akash, runpod, shadeform, verda } = terms.sources;
  const { vendor, model, ram, interface: connector } = akash.selector;
  const { min, max } = sanityUnits(terms);
  return {
    indexId: keccak256(toBytes(JSON.stringify(["piry-index-v1", terms.mode, terms.sourceId, ...COMPOSITE_SOURCES]))),
    specHash: keccak256(toBytes(JSON.stringify({
      schemaVersion: 1, mode: terms.mode, sourceId: terms.sourceId,
      sources: {
        akash: {
          selector: { vendor, model, ram, interface: connector }, priceField: akash.priceField, minProviders: akash.minProviders,
        },
        runpod: { gpuTypeId: runpod.gpuTypeId, gpuCount: runpod.gpuCount },
        shadeform: {
          gpuType: shadeform.gpuType, numGpus: shadeform.numGpus, interconnect: shadeform.interconnect,
          excludeClouds: shadeform.excludeClouds, minClouds: shadeform.minClouds,
        },
        verda: { gpuDescription: verda.gpuDescription, numberOfGpus: verda.numberOfGpus },
      },
      endpoints: COMPOSITE_ENDPOINTS,
      minSources: terms.minSources, sanityBounds: { min: min.toString(), max: max.toString() },
      priceDecimals: terms.priceDecimals, methodology: COMPOSITE_METHODOLOGY,
    }))),
  };
}

export function indexIdentity(terms: AnyTerms): { indexId: Hex; specHash: Hex } {
  validateTerms(terms);
  if (terms.mode === "AKASH") return akashIdentity(terms);
  if (terms.mode === "COMPOSITE") return compositeIdentity(terms);
  return {
    indexId: keccak256(toBytes(JSON.stringify(["piry-index-v1", terms.mode, terms.sourceId, terms.datasetId]))),
    specHash: keccak256(toBytes(JSON.stringify(specification(terms)))),
  };
}

export function validateDataset(data: unknown, terms: IndexTerms, nowSeconds: number): ValidatedIndex {
  const { price, publishedAt, evidenceHash, canonicalEvidence } = validate(data, terms, nowSeconds, "full");
  return { price, publishedAt, evidenceHash, canonicalEvidence };
}

// Period-to-date variant: only slots completed at publication time are required, contiguous from periodStart.
export function validatePartialDataset(data: unknown, terms: IndexTerms, nowSeconds: number): ValidatedMark {
  return validate(data, terms, nowSeconds, "to-date");
}

// Mark policy: until the first period slot completes the mark is the latest completed slot's single observation
// (the grid extends backwards from periodStart); from then on it is the period-to-date mean.
export function validateMarkDataset(data: unknown, terms: IndexTerms, nowSeconds: number): ValidatedMark {
  const publishedAt = (data as { publishedAt?: unknown } | null)?.publishedAt;
  const spot = typeof publishedAt === "number" && publishedAt < terms.periodStart + terms.slotSeconds;
  return validate(data, terms, nowSeconds, spot ? "spot" : "to-date");
}

function validate(data: unknown, terms: IndexTerms, nowSeconds: number, scope: Scope): ValidatedMark {
  validateTerms(terms);
  integer(nowSeconds, "nowSeconds");
  requireValue(scope !== "full" || terms.periodEnd <= nowSeconds, "requested period must be completed, not future");
  const source = record(data, [
    "schemaVersion", "mode", "sourceId", "datasetId", "hardware", "currency", "units", "priceDecimals",
    "slotSeconds", "indexId", "specHash", "periodStart", "periodEnd", "publishedAt", "observations",
  ]);
  requireValue(source.schemaVersion === 1, "unsupported schema version");
  const identity = indexIdentity(terms);
  for (const field of ["mode", "sourceId", "datasetId", "currency", "units", "priceDecimals", "slotSeconds", "periodStart", "periodEnd"] as const) {
    requireValue(source[field] === terms[field], `${field} binding mismatch`);
  }
  requireValue(source.indexId === identity.indexId && source.specHash === identity.specHash, "identity/spec binding mismatch");
  const spec = hardware(source.hardware);
  requireValue(JSON.stringify(spec) === JSON.stringify(hardware(terms.hardware)), "hardware binding mismatch");
  const publishedAt = integer(source.publishedAt, "publishedAt");
  const totalSlots = (terms.periodEnd - terms.periodStart) / terms.slotSeconds;
  const earliest = scope === "full" ? terms.periodEnd : scope === "to-date" ? terms.periodStart + terms.slotSeconds : 0;
  requireValue(publishedAt >= earliest && publishedAt <= nowSeconds
    && nowSeconds - publishedAt <= terms.maxPublicationAgeSeconds, "future, stale or premature publication");
  const completed = Math.floor((publishedAt - terms.periodStart) / terms.slotSeconds);
  const expectedCount = scope === "full" ? totalSlots : scope === "spot" ? 1 : Math.min(totalSlots, completed);
  const slotLow = scope === "spot" ? terms.periodStart + (completed - 1) * terms.slotSeconds : terms.periodStart;
  const slotLimit = scope === "spot" ? slotLow + terms.slotSeconds : terms.periodStart + expectedCount * terms.slotSeconds;
  requireValue(Array.isArray(source.observations) && source.observations.length === expectedCount, "incomplete slot coverage");
  const seen = new Set<number>();
  let total = 0n;
  const observations = source.observations.map(value => {
    const row = record(value, ["slotStart", "observedAt", "price"]);
    const slotStart = integer(row.slotStart, "slotStart");
    const observedAt = integer(row.observedAt, "observedAt");
    requireValue(slotStart >= slotLow && slotStart < slotLimit, "slot out of range");
    requireValue((slotStart - terms.periodStart) % terms.slotSeconds === 0, "slot off grid");
    requireValue(!seen.has(slotStart), "duplicate slot");
    seen.add(slotStart);
    requireValue(observedAt >= slotStart && observedAt < slotStart + terms.slotSeconds
      && observedAt <= publishedAt && observedAt <= nowSeconds, "stale, future or out-of-slot observation");
    requireValue(typeof row.price === "string" && row.price.length <= 78 && /^(0|[1-9][0-9]*)$/.test(row.price), "price must be canonical integer string");
    const price = BigInt(row.price);
    requireValue(price <= MAX_PRICE, "price exceeds safe accumulation bound");
    total += price;
    requireValue(total <= UINT256_MAX, "price sum overflow");
    return { slotStart, observedAt, price: row.price };
  }).sort((a, b) => a.slotStart - b.slotStart);
  const methodology = scope === "spot" ? SPOT_METHODOLOGY : METHODOLOGY;
  const canonicalEvidence = JSON.stringify({
    methodology,
    dataset: {
      schemaVersion: 1, mode: terms.mode, sourceId: terms.sourceId, datasetId: terms.datasetId, hardware: spec,
      currency: terms.currency, units: terms.units, priceDecimals: terms.priceDecimals, slotSeconds: terms.slotSeconds,
      ...identity, periodStart: terms.periodStart, periodEnd: terms.periodEnd, publishedAt, observations,
    },
  });
  return {
    price: total / BigInt(expectedCount), publishedAt,
    evidenceHash: keccak256(toBytes(canonicalEvidence)), canonicalEvidence,
    observedAt: observations[expectedCount - 1].observedAt, slots: expectedCount, methodology,
  };
}
