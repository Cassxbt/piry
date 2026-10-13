import { keccak256, toBytes, type Hex } from "viem";

export interface Observation {
  slotStart: number;
  observedAt: number;
  price: string;
}

export interface EvidenceDataset {
  mode: string;
  sourceId: string;
  datasetId: string;
  hardware: { model: string; region: string };
  units: string;
  slotSeconds: number;
  periodStart: number;
  periodEnd: number;
  publishedAt: number;
  indexId: string;
  specHash: string;
  observations: Observation[];
}

export type SourceEntry = { ok: true; value: string; count: number } | { ok: false; reason: string };

export interface CompositeEvidence {
  methodology: string;
  specHash: string;
  observedAt: number;
  sources: Record<string, SourceEntry>;
}

// verified: every check passed. failed: a check failed or the bytes do not hash to the on-chain value. unverified: the
// hash matches but this page cannot re-derive the price (unsupported methodology). unavailable: no file to check.
export type EvidenceState = "verified" | "failed" | "unverified" | "unavailable";

export interface CheckItem {
  id: "hash" | "format" | "canonical" | "quorum" | "median" | "price" | "bound" | "coverage" | "observed" | "method";
  label: string;
  state: "pass" | "fail" | "skip";
  detail?: string;
}

export interface EvidenceTarget {
  evidenceHash: Hex;
  price: bigint;
  indexId: Hex;
  specHash: Hex;
  periodStart: bigint;
  periodEnd: bigint;
  publishedAt: bigint;
  // Smallest number of valid composite sources the series accepts; null when unknown.
  minSources: number | null;
}

export interface EvidenceCheck {
  state: Exclude<EvidenceState, "unavailable">;
  methodology: string | null;
  supported: boolean;
  hashMatches: boolean;
  computedHash: Hex;
  priceMatches: boolean | null;
  computedPrice: bigint | null;
  checks: CheckItem[];
  dataset: EvidenceDataset | null;
  composite: CompositeEvidence | null;
  parseError: string | null;
}

export const DEMO_METHODOLOGY = "equal-slot-mean-floor-v1";
export const COMPOSITE_METHODOLOGY = "composite-median-v1";
const MAX_SLOTS = 168;
// The workflow dates the on-chain report up to a few seconds before the time recorded in the evidence (15 s in the live
// configuration) so clock skew cannot put it ahead of the chain. 60 s leaves room without accepting an unrelated snapshot.
const MAX_REPORT_MARGIN_SECONDS = 60n;
const reportMatches = (evidenceTime: number, target: EvidenceTarget) => {
  const lead = BigInt(evidenceTime) - target.publishedAt;
  return lead >= 0n && lead <= MAX_REPORT_MARGIN_SECONDS && BigInt(evidenceTime) >= target.periodEnd;
};
const COMPOSITE_SOURCES = ["akash", "runpod", "shadeform", "verda"];
const FAILURE_REASONS = ["http-status", "response-too-large", "invalid-response", "outside-sanity-bounds", "below-minimum-count", "unavailable-or-no-consensus"];

// The workflow hashes the canonical JSON string as UTF-8, so the served file must be byte-identical to it.
export function hashEvidence(text: string): Hex {
  return keccak256(toBytes(text));
}

// Mirrors canonicalJson in workflow/akash.ts: keys sorted at every depth, no whitespace.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Equal-slot mean, rounded down: the methodology "equal-slot-mean-floor-v1".
export function meanFloor(observations: readonly Observation[]): bigint | null {
  if (observations.length === 0) return null;
  const total = observations.reduce((sum, o) => sum + BigInt(o.price), 0n);
  return total / BigInt(observations.length);
}

// Mirrors median in workflow/composite.ts: for an even count, the floor of the mean of the two middle values.
export function medianFloor(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[middle] as bigint) : ((sorted[middle - 1] as bigint) + (sorted[middle] as bigint)) / 2n;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const text = (value: unknown) => (typeof value === "string" ? value : "");

function readDemo(value: unknown): EvidenceDataset | string {
  if (!isObject(value) || !Array.isArray(value.observations)) return "no dataset.observations in the evidence file";
  const { slotSeconds, periodStart, periodEnd, publishedAt } = value;
  if (!isInt(slotSeconds) || !isInt(periodStart) || !isInt(periodEnd) || !isInt(publishedAt)) return "dataset period, slot length or publication time is not an integer";
  const observations: Observation[] = [];
  for (const row of value.observations) {
    if (!isObject(row) || !isInt(row.slotStart) || !isInt(row.observedAt) || typeof row.price !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(row.price)) {
      return "an observation is not {slotStart, observedAt, price} with an integer price string";
    }
    observations.push({ slotStart: row.slotStart, observedAt: row.observedAt, price: row.price });
  }
  const hardware = isObject(value.hardware) ? value.hardware : {};
  return {
    mode: text(value.mode), sourceId: text(value.sourceId), datasetId: text(value.datasetId), units: text(value.units),
    hardware: { model: text(hardware.model), region: text(hardware.region) },
    slotSeconds, periodStart, periodEnd, publishedAt, indexId: text(value.indexId), specHash: text(value.specHash), observations,
  };
}

function readComposite(value: unknown): CompositeEvidence | string {
  if (!isObject(value) || Object.keys(value).sort().join() !== "methodology,observedAt,sources,specHash") return "evidence must hold exactly methodology, observedAt, sources and specHash";
  const { methodology, observedAt, sources, specHash } = value;
  if (typeof methodology !== "string" || !isInt(observedAt) || typeof specHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(specHash)) return "methodology, observedAt or specHash is malformed";
  if (!isObject(sources) || Object.keys(sources).sort().join() !== [...COMPOSITE_SOURCES].sort().join()) return "evidence must list every source exactly once";
  const entries: Record<string, SourceEntry> = {};
  for (const name of COMPOSITE_SOURCES) {
    const entry = sources[name];
    if (!isObject(entry)) return `source ${name} is not an object`;
    if (entry.ok === true) {
      if (typeof entry.value !== "string" || !/^[1-9][0-9]{0,77}$/.test(entry.value) || !isInt(entry.count) || entry.count < 1) return `source ${name} has an invalid value or count`;
      entries[name] = { ok: true, value: entry.value, count: entry.count };
    } else {
      if (entry.ok !== false || typeof entry.reason !== "string" || !FAILURE_REASONS.includes(entry.reason)) return `source ${name} has an unknown failure reason`;
      entries[name] = { ok: false, reason: entry.reason };
    }
  }
  return { methodology, specHash, observedAt, sources: entries };
}

const check = (ok: boolean, id: CheckItem["id"], label: string, detail?: string): CheckItem => ({ id, label, state: ok ? "pass" : "fail", detail });
const skip = (id: CheckItem["id"], label: string, detail?: string): CheckItem => ({ id, label, state: "skip", detail });

function checkDemo(d: EvidenceDataset, target: EvidenceTarget): { items: CheckItem[]; price: bigint | null } {
  const mean = meanFloor(d.observations);
  const bound = sameHex(d.indexId, target.indexId) && sameHex(d.specHash, target.specHash) && BigInt(d.periodStart) === target.periodStart && BigInt(d.periodEnd) === target.periodEnd;

  const span = d.periodEnd - d.periodStart;
  const wholeSlots = d.slotSeconds > 0 && span > 0 && span % d.slotSeconds === 0 && span / d.slotSeconds <= MAX_SLOTS;
  const slots = wholeSlots ? span / d.slotSeconds : 0;
  const problems: string[] = [];
  if (!wholeSlots) problems.push(`the period is not 1 to ${MAX_SLOTS} whole slots`);
  else {
    const seen = new Set(d.observations.map((o) => o.slotStart));
    const duplicated = d.observations.length - seen.size;
    let missing = 0;
    for (let i = 0; i < slots; i++) if (!seen.has(d.periodStart + i * d.slotSeconds)) missing++;
    if (duplicated > 0) problems.push(`${duplicated} duplicated slot${duplicated === 1 ? "" : "s"}`);
    if (missing > 0) problems.push(`${missing} missing slot${missing === 1 ? "" : "s"}`);
    if (d.observations.length !== slots) problems.push(`${d.observations.length} observations for ${slots} slots`);
    if (problems.length === 0 && d.observations.some((o, i) => o.slotStart !== d.periodStart + i * d.slotSeconds)) problems.push("slots are out of order or off the grid");
    if (d.observations.some((o) => o.observedAt < o.slotStart || o.observedAt >= o.slotStart + d.slotSeconds || o.observedAt > d.publishedAt)) problems.push("an observation falls outside its slot or after publication");
  }
  const observed = reportMatches(d.publishedAt, target);
  return {
    price: mean,
    items: [
      check(mean !== null && mean === target.price, "price", "Equal-slot mean, rounded down, reproduces the settled price", mean !== null ? `mean of ${d.observations.length} observations = ${mean}, chain settled at ${target.price}` : "no observations"),
      check(bound, "bound", "Evidence is bound to this series (index ID, spec hash and period match the market)"),
      check(problems.length === 0, "coverage", "Every slot of the period appears exactly once, in order, within its window", problems.length === 0 ? `${d.observations.length} of ${slots} slots, ${d.slotSeconds}s each` : problems.join("; ")),
      check(observed, "observed", "Publication time matches the settled report's (within the workflow's time margin) and is not before the period end", `evidence ${d.publishedAt}, chain ${target.publishedAt}`),
    ],
  };
}

function checkComposite(raw: unknown, body: string, target: EvidenceTarget): { items: CheckItem[]; price: bigint | null; evidence: CompositeEvidence | null } {
  const evidence = readComposite(raw);
  if (typeof evidence === "string") return { items: [check(false, "canonical", "Evidence has the shape the workflow produces", evidence)], price: null, evidence: null };
  const values = Object.values(evidence.sources).flatMap((s) => (s.ok ? [BigInt(s.value)] : []));
  const median = medianFloor(values);
  const observed = reportMatches(evidence.observedAt, target);
  return {
    evidence,
    price: median,
    items: [
      check(canonicalJson(raw) === body, "canonical", "Evidence is the canonical form: sorted keys, no whitespace, no extra fields"),
      target.minSources === null
        ? skip("quorum", "Enough sources returned a valid price", "the series does not state its minimum")
        : check(values.length >= target.minSources, "quorum", "Enough sources returned a valid price", `${values.length} valid of ${COMPOSITE_SOURCES.length}, ${target.minSources} required`),
      check(median !== null && median === target.price, "median", "Median of the valid sources, rounded down, reproduces the settled price", median !== null ? `median of ${values.length} values = ${median}, chain settled at ${target.price}` : "no valid source"),
      check(sameHex(evidence.specHash, target.specHash), "bound", "Evidence is bound to this series (spec hash matches the market)"),
      check(observed, "observed", "Snapshot time matches the settled report's (within the workflow's time margin) and is not before the period end", `evidence ${evidence.observedAt}, chain ${target.publishedAt}, period end ${target.periodEnd}`),
    ],
  };
}

export function checkEvidence(body: string, target: EvidenceTarget): EvidenceCheck {
  const computedHash = hashEvidence(body);
  const hashMatches = sameHex(computedHash, target.evidenceHash);
  const hashItem = check(hashMatches, "hash", "keccak256 of the evidence file equals the evidence hash settled on-chain", `file ${computedHash} vs chain ${target.evidenceHash}`);
  const base = { hashMatches, computedHash, methodology: null, supported: false, priceMatches: null, computedPrice: null, dataset: null, composite: null, parseError: null };
  const finish = (partial: Partial<EvidenceCheck>, items: CheckItem[]): EvidenceCheck => {
    const checks = [hashItem, ...items];
    const supported = partial.supported ?? false;
    const state = checks.some((c) => c.state === "fail") ? "failed" : supported && checks.every((c) => c.state === "pass") ? "verified" : "unverified";
    return { ...base, ...partial, state, checks, supported };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return finish({ parseError }, [check(false, "format", "The evidence file is JSON", parseError)]);
  }
  const methodology = isObject(parsed) && typeof parsed.methodology === "string" ? parsed.methodology : null;

  if (methodology === DEMO_METHODOLOGY) {
    const dataset = isObject(parsed) ? readDemo(parsed.dataset) : "not an object";
    if (typeof dataset === "string") return finish({ methodology, supported: true, parseError: dataset }, [check(false, "format", "The dataset has the shape the workflow produces", dataset)]);
    const { items, price } = checkDemo(dataset, target);
    return finish({ methodology, supported: true, dataset, computedPrice: price, priceMatches: price === null ? null : price === target.price }, items);
  }
  if (methodology === COMPOSITE_METHODOLOGY) {
    const { items, price, evidence } = checkComposite(parsed, body, target);
    return finish({ methodology, supported: true, composite: evidence, computedPrice: price, priceMatches: price === null ? null : price === target.price }, items);
  }
  return finish({ methodology }, [skip("method", `Methodology ${methodology ? `"${methodology}"` : "(none)"} is not one this page can re-derive`, "The hash proves the bytes only; it does not show where the price came from.")]);
}

// Live composite evidence is served by its on-chain hash (with or without the 0x prefix); DEMO series keep one file per series folder.
export function evidenceUrls(base: string, mode: "DEMO" | "LIVE", hash: Hex): string[] {
  return mode === "LIVE" ? [`/evidence/composite/${hash}.json`, `/evidence/composite/${hash.slice(2)}.json`] : [`${base}/evidence.json`];
}

export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.text();
    // Vite's dev server answers unknown paths with index.html; treat that as missing.
    return body.trimStart().startsWith("<") ? null : body;
  } catch {
    return null;
  }
}

export async function fetchFirst(urls: readonly string[]): Promise<{ url: string; text: string } | null> {
  for (const url of urls) {
    const found = await fetchText(url);
    if (found !== null) return { url, text: found };
  }
  return null;
}
