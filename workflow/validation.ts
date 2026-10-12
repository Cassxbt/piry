import { keccak256, toBytes, type Hex } from "viem";

export const METHODOLOGY = "equal-slot-mean-floor-v1";
export const MAX_SLOTS = 168;
export const UINT256_MAX = (1n << 256n) - 1n;
export const MAX_PRICE = UINT256_MAX / BigInt(MAX_SLOTS);
export const MAX_RESPONSE_BYTES = 65536;

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
export type ValidatedIndex = {
  price: bigint;
  publishedAt: number;
  evidenceHash: Hex;
  canonicalEvidence: string;
};

function requireValue(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "invalid schema object");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  requireValue(keys.length === fields.length && fields.every(key => Object.hasOwn(object, key)), "invalid schema fields");
  return object;
}

function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
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

export function validateTerms(terms: IndexTerms): void {
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

export function indexIdentity(terms: IndexTerms): { indexId: Hex; specHash: Hex } {
  validateTerms(terms);
  return {
    indexId: keccak256(toBytes(JSON.stringify(["piry-index-v1", terms.mode, terms.sourceId, terms.datasetId]))),
    specHash: keccak256(toBytes(JSON.stringify(specification(terms)))),
  };
}

export function validateDataset(data: unknown, terms: IndexTerms, nowSeconds: number): ValidatedIndex {
  validateTerms(terms);
  integer(nowSeconds, "nowSeconds");
  requireValue(terms.periodEnd <= nowSeconds, "requested period must be completed, not future");
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
  requireValue(publishedAt >= terms.periodEnd && publishedAt <= nowSeconds
    && nowSeconds - publishedAt <= terms.maxPublicationAgeSeconds, "future, stale or premature publication");
  const expectedCount = (terms.periodEnd - terms.periodStart) / terms.slotSeconds;
  requireValue(Array.isArray(source.observations) && source.observations.length === expectedCount, "incomplete slot coverage");
  const seen = new Set<number>();
  let total = 0n;
  const observations = source.observations.map(value => {
    const row = record(value, ["slotStart", "observedAt", "price"]);
    const slotStart = integer(row.slotStart, "slotStart");
    const observedAt = integer(row.observedAt, "observedAt");
    requireValue(slotStart >= terms.periodStart && slotStart < terms.periodEnd, "slot out of range");
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
  const canonicalEvidence = JSON.stringify({
    methodology: METHODOLOGY,
    dataset: {
      schemaVersion: 1, mode: terms.mode, sourceId: terms.sourceId, datasetId: terms.datasetId, hardware: spec,
      currency: terms.currency, units: terms.units, priceDecimals: terms.priceDecimals, slotSeconds: terms.slotSeconds,
      ...identity, periodStart: terms.periodStart, periodEnd: terms.periodEnd, publishedAt, observations,
    },
  });
  return {
    price: total / BigInt(expectedCount), publishedAt,
    evidenceHash: keccak256(toBytes(canonicalEvidence)), canonicalEvidence,
  };
}
