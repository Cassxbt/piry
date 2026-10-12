import { encodeAbiParameters, isAddress, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { METHODOLOGY, UINT256_MAX, indexIdentity, validateDataset, type IndexTerms, type ValidatedIndex } from "./validation.js";

export const REPORT_ABI = parseAbiParameters(
  "(address market,uint256 chainId,bytes32 indexId,bytes32 specHash,uint8 priceDecimals,uint64 periodStart,uint64 periodEnd,uint256 price,uint64 publishedAt,bytes32 evidenceHash)"
);

export function encodeMarketReport(
  validated: ValidatedIndex, terms: IndexTerms, destination: { market: Address; chainId: bigint },
): Hex {
  if (!isAddress(destination.market) || destination.market.toLowerCase() === zeroAddress
    || typeof destination.chainId !== "bigint" || destination.chainId <= 0n || destination.chainId > UINT256_MAX) {
    throw new Error("invalid report destination");
  }
  const evidence = JSON.parse(validated.canonicalEvidence);
  if (evidence.methodology !== METHODOLOGY) throw new Error("evidence methodology binding mismatch");
  const checked = validateDataset(evidence.dataset, terms, validated.publishedAt);
  if (checked.price !== validated.price || checked.publishedAt !== validated.publishedAt
    || checked.evidenceHash !== validated.evidenceHash || checked.canonicalEvidence !== validated.canonicalEvidence) {
    throw new Error("evidence binding mismatch");
  }
  return encodeAbiParameters(REPORT_ABI, [{
    ...destination, ...indexIdentity(terms), priceDecimals: terms.priceDecimals,
    periodStart: BigInt(terms.periodStart), periodEnd: BigInt(terms.periodEnd),
    price: validated.price, publishedAt: BigInt(validated.publishedAt), evidenceHash: validated.evidenceHash,
  }]);
}
