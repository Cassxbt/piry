import { keccak256, toBytes } from "viem";
import {
  AKASH_METHODOLOGY, AKASH_SOURCE_URL, UINT256_MAX, decimalUnits, integer, plainObject, requireValue, sanityUnits, validateTerms,
  type AkashRule, type AkashSelector, type AkashTerms, type SnapshotTerms, type ValidatedMark,
} from "./validation.js";

export { AKASH_SOURCE_URL };
export type AkashScope = "settlement" | "mark";

const MINUTE_SECONDS = 60;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Converts from the number's shortest decimal string, never through float multiplication.
export function numberToUnits(value: unknown, decimals: number): bigint {
  requireValue(typeof value === "number" && Number.isFinite(value) && value > 0, "price must be a finite positive number");
  const units = decimalUnits(String(value), decimals, false);
  requireValue(units <= UINT256_MAX, "price exceeds uint256");
  return units;
}

// The API publishes no timestamp, so the DON clock floored to the minute dates the snapshot on every node. Settlement
// needs the floored minute itself to reach periodEnd: the market rejects a publishedAt before it.
export function snapshotTime(terms: SnapshotTerms, nowSeconds: number, scope: AkashScope): number {
  integer(nowSeconds, "nowSeconds");
  const observedAt = nowSeconds - (nowSeconds % MINUTE_SECONDS);
  requireValue(scope === "mark" || (observedAt >= terms.periodEnd && nowSeconds - terms.periodEnd <= terms.maxPublicationAgeSeconds),
    "settlement snapshot is premature or outside the publication window");
  return observedAt;
}

const matchesSelector = (model: unknown, selector: AkashSelector) => typeof model === "object" && model !== null
  && (Object.keys(selector) as (keyof AkashSelector)[]).every(key => (model as Record<string, unknown>)[key] === selector[key]);

// Units and provider count of the one model record the rule selects; shared with the composite index.
export function akashQuote(model: unknown, rule: AkashRule, decimals: number): { units: bigint; providers: number } {
  const matched = plainObject(model, "model record");
  requireValue(matchesSelector(matched, rule.selector), "model record does not match the selector");
  const price = plainObject(matched.price, "price object");
  const providers = plainObject(matched.providerAvailability, "provider availability");
  requireValue(price.currency === "USD", "price currency must be USD");
  requireValue(typeof providers.total === "number" && Number.isSafeInteger(providers.total) && providers.total >= rule.minProviders,
    "provider count below the minimum");
  return { units: numberToUnits(price[rule.priceField], decimals), providers: providers.total };
}

export function selectAkashModel(body: unknown, selector: AkashSelector): unknown {
  const { models } = plainObject(body);
  requireValue(Array.isArray(models), "models must be an array");
  const matches = models.filter(model => matchesSelector(model, selector));
  requireValue(matches.length === 1, `exactly one model must match the selector, found ${matches.length}`);
  return matches[0];
}

function snapshot(model: unknown, terms: AkashTerms, nowSeconds: number, scope: AkashScope): ValidatedMark {
  validateTerms(terms);
  const observedAt = snapshotTime(terms, nowSeconds, scope);
  const { units } = akashQuote(model, terms, terms.priceDecimals);
  const { min, max } = sanityUnits(terms);
  requireValue(units >= min && units <= max, "price outside the sanity bounds");
  const canonicalEvidence = canonicalJson({
    methodology: AKASH_METHODOLOGY, selector: terms.selector, priceField: terms.priceField, model, observedAt,
  });
  return {
    price: units, publishedAt: observedAt, evidenceHash: keccak256(toBytes(canonicalEvidence)), canonicalEvidence,
    observedAt, slots: 1, methodology: AKASH_METHODOLOGY,
  };
}

export function validateAkashResponse(body: unknown, terms: AkashTerms, nowSeconds: number, scope: AkashScope): ValidatedMark {
  return snapshot(selectAkashModel(body, terms.selector), terms, nowSeconds, scope);
}

// Recomputes the evidence from its embedded record, so any edit to the selector, field, time or record is detected.
export function validateAkashEvidence(evidence: string, terms: AkashTerms, nowSeconds: number, scope: AkashScope): ValidatedMark {
  const { model } = plainObject(JSON.parse(evidence));
  const validated = snapshot(model, terms, nowSeconds, scope);
  requireValue(validated.canonicalEvidence === evidence, "evidence is not canonical for these terms and time");
  return validated;
}
