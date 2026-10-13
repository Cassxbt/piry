import { encodeAbiParameters, isAddress, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { validateAkashEvidence } from "./akash.js";
import { validateCompositeEvidence } from "./composite.js";
import {
  METHODOLOGY, UINT256_MAX, indexIdentity, validateDataset, validateMarkDataset,
  type AnyTerms, type SnapshotTerms, type ValidatedIndex, type ValidatedMark,
} from "./validation.js";

export const REPORT_ABI = parseAbiParameters(
  "(address market,uint256 chainId,bytes32 indexId,bytes32 specHash,uint8 priceDecimals,uint64 periodStart,uint64 periodEnd,uint256 price,uint64 publishedAt,bytes32 evidenceHash)"
);

export const MARK_REPORT_ABI = parseAbiParameters(
  "(address feed,uint256 chainId,bytes32 indexId,uint256 indexPrice,uint64 observedAt,bytes32 evidenceHash)"
);

function requireDestination(target: Address, chainId: bigint): void {
  if (!isAddress(target) || target.toLowerCase() === zeroAddress
    || typeof chainId !== "bigint" || chainId <= 0n || chainId > UINT256_MAX) {
    throw new Error("invalid report destination");
  }
}

function evidenceDataset(validated: ValidatedIndex): unknown {
  const evidence = JSON.parse(validated.canonicalEvidence);
  if (evidence.methodology !== METHODOLOGY) throw new Error("evidence methodology binding mismatch");
  return evidence.dataset;
}

function requireBound(checked: ValidatedIndex, validated: ValidatedIndex): void {
  if (checked.price !== validated.price || checked.publishedAt !== validated.publishedAt
    || checked.evidenceHash !== validated.evidenceHash || checked.canonicalEvidence !== validated.canonicalEvidence) {
    throw new Error("evidence binding mismatch");
  }
}

function recheckSnapshot(validated: ValidatedIndex, terms: SnapshotTerms, scope: "settlement" | "mark"): ValidatedMark {
  const { canonicalEvidence, publishedAt } = validated;
  return terms.mode === "AKASH"
    ? validateAkashEvidence(canonicalEvidence, terms, publishedAt, scope)
    : validateCompositeEvidence(canonicalEvidence, terms, publishedAt, scope);
}

// publishedAtMarginSeconds backdates only the report's own time, like the mark path, so it cannot lead the chain's clock;
// the evidence keeps the snapshot minute and is validated unchanged. The market rejects a report time before expiry.
export function encodeMarketReport(
  validated: ValidatedIndex, terms: AnyTerms, destination: { market: Address; chainId: bigint },
  publishedAtMarginSeconds = 0,
): Hex {
  requireDestination(destination.market, destination.chainId);
  requireBound(terms.mode === "DEMO"
    ? validateDataset(evidenceDataset(validated), terms, validated.publishedAt)
    : recheckSnapshot(validated, terms, "settlement"), validated);
  if (!Number.isSafeInteger(publishedAtMarginSeconds) || publishedAtMarginSeconds < 0) throw new Error("invalid publication time margin");
  const publishedAt = validated.publishedAt - publishedAtMarginSeconds;
  if (publishedAt < terms.periodEnd) throw new Error("settlement time margin puts the report before expiry");
  return encodeAbiParameters(REPORT_ABI, [{
    ...destination, ...indexIdentity(terms), priceDecimals: terms.priceDecimals,
    periodStart: BigInt(terms.periodStart), periodEnd: BigInt(terms.periodEnd),
    price: validated.price, publishedAt: BigInt(publishedAt), evidenceHash: validated.evidenceHash,
  }]);
}

// observedAtMarginSeconds dates the observation conservatively so the feed's observedAt <= block.timestamp check
// survives clock skew between the data source and the chain.
export function encodeMarkReport(
  validated: ValidatedMark, terms: AnyTerms, destination: { feed: Address; chainId: bigint },
  observedAtMarginSeconds = 0,
): Hex {
  requireDestination(destination.feed, destination.chainId);
  if (!Number.isSafeInteger(observedAtMarginSeconds) || observedAtMarginSeconds < 0
    || observedAtMarginSeconds >= validated.observedAt) throw new Error("invalid observation time margin");
  // The mean and the pre-period spot differ only in the methodology label, which is part of the canonical evidence.
  const checked = terms.mode === "DEMO"
    ? validateMarkDataset(JSON.parse(validated.canonicalEvidence).dataset, terms, validated.publishedAt)
    : recheckSnapshot(validated, terms, "mark");
  requireBound(checked, validated);
  if (checked.observedAt !== validated.observedAt) throw new Error("evidence binding mismatch");
  return encodeAbiParameters(MARK_REPORT_ABI, [{
    feed: destination.feed, chainId: destination.chainId, indexId: indexIdentity(terms).indexId,
    indexPrice: validated.price, observedAt: BigInt(validated.observedAt - observedAtMarginSeconds),
    evidenceHash: validated.evidenceHash,
  }]);
}
