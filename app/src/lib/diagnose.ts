import type { Address, Hex } from "viem";

export interface SettlementReport {
  market: Address;
  chainId: bigint;
  indexId: Hex;
  specHash: Hex;
  priceDecimals: number;
  periodStart: bigint;
  periodEnd: bigint;
  price: bigint;
  publishedAt: bigint;
  evidenceHash: Hex;
}

export interface MarkReport {
  feed: Address;
  chainId: bigint;
  indexId: Hex;
  indexPrice: bigint;
  observedAt: bigint;
  evidenceHash: Hex;
}

export interface SettlementContext {
  market: Address;
  chainId: bigint;
  indexId: Hex;
  specHash: Hex;
  priceDecimals: number;
  periodStart: bigint;
  periodEnd: bigint;
  maxReportAge: bigint;
  blockTimestamp: bigint;
  alreadySettled: boolean;
  sender: Address;
  operator: Address | null;
}

export interface Diagnosis {
  errorName: string;
  reasons: string[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO_HASH = `0x${"0".repeat(64)}`;

// Re-applies the checks of SimulationSettlementReceiver.onReport and ComputeMarket.settle, in the contracts'
// own order, to a submitted report. The forwarder swallows the receiver's revert, so this is a reconstruction
// from the report and chain state, not the contract's own message.
export function diagnoseSettlement(report: SettlementReport | null, c: SettlementContext): Diagnosis | null {
  if (c.operator !== null && !same(c.sender, c.operator)) {
    return { errorName: "UntrustedOperator", reasons: ["The transaction was not sent by the operator wallet the receiver trusts."] };
  }
  if (report === null) {
    return { errorName: "InvalidPayload", reasons: ["The report payload is not the 320-byte settlement layout."] };
  }
  if (c.alreadySettled) {
    return { errorName: "AlreadySettled", reasons: ["The market had already settled in an earlier block. A market settles once."] };
  }
  if (c.blockTimestamp < c.periodEnd) {
    return { errorName: "BeforeExpiry", reasons: ["The measured period had not ended when this report arrived."] };
  }
  const reasons: string[] = [];
  if (!same(report.market, c.market)) reasons.push("The report names a different market address.");
  if (report.chainId !== c.chainId) reasons.push(`The report is bound to chain ${report.chainId}, but this transaction ran on chain ${c.chainId}.`);
  if (!same(report.indexId, c.indexId)) reasons.push("The index ID does not match the series.");
  if (!same(report.specHash, c.specHash)) reasons.push("The specification hash does not match the series.");
  if (report.priceDecimals !== c.priceDecimals) reasons.push("The price decimals differ from the series.");
  if (report.periodStart !== c.periodStart || report.periodEnd !== c.periodEnd) reasons.push("The reported period is not this series' period.");
  if (same(report.evidenceHash, ZERO_HASH)) reasons.push("The evidence hash is empty.");
  if (report.publishedAt < c.periodEnd) reasons.push("The dataset was published before the period ended.");
  if (report.publishedAt > c.blockTimestamp) reasons.push("The dataset claims a publication time in the future.");
  else if (c.blockTimestamp - report.publishedAt > c.maxReportAge) {
    reasons.push(`The dataset was published ${c.blockTimestamp - report.publishedAt}s before delivery; the series accepts reports at most ${c.maxReportAge}s old.`);
  }
  return reasons.length > 0 ? { errorName: "InvalidReport", reasons } : null;
}

export interface MarkContext {
  feed: Address;
  chainId: bigint;
  indexId: Hex;
  blockTimestamp: bigint;
  marketSettled: boolean;
  newestObservedAt: bigint | null;
  sender: Address;
  operator: Address | null;
}

export function diagnoseMark(report: MarkReport | null, c: MarkContext): Diagnosis | null {
  if (c.operator !== null && !same(c.sender, c.operator)) {
    return { errorName: "UntrustedOperator", reasons: ["The transaction was not sent by the operator wallet the feed trusts."] };
  }
  if (report === null) return { errorName: "InvalidPayload", reasons: ["The mark payload is not the 192-byte layout."] };
  if (c.marketSettled) return { errorName: "MarketSettled", reasons: ["The market has settled, so the feed accepts no further marks."] };
  const reasons: string[] = [];
  if (!same(report.feed, c.feed)) reasons.push("The mark names a different feed.");
  if (report.chainId !== c.chainId) reasons.push(`The mark is bound to chain ${report.chainId}, but ran on chain ${c.chainId}.`);
  if (!same(report.indexId, c.indexId)) reasons.push("The index ID does not match the series.");
  if (c.newestObservedAt !== null && report.observedAt <= c.newestObservedAt) {
    reasons.push("The feed already holds a round observed at or after this time. Marks must advance.");
  }
  if (report.observedAt > c.blockTimestamp) reasons.push("The observation time is in the future.");
  return reasons.length > 0 ? { errorName: "InvalidMark", reasons } : null;
}
