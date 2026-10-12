import { describe, expect, it } from "vitest";
import { diagnoseMark, diagnoseSettlement, type MarkContext, type SettlementContext, type SettlementReport } from "../lib/diagnose";

const market = "0x1111111111111111111111111111111111111111" as const;
const operator = "0x2222222222222222222222222222222222222222" as const;
const stranger = "0x3333333333333333333333333333333333333333" as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const ctx: SettlementContext = {
  market,
  chainId: 31337n,
  indexId: hash(1),
  specHash: hash(2),
  priceDecimals: 6,
  periodStart: 1_000n,
  periodEnd: 2_000n,
  maxReportAge: 600n,
  blockTimestamp: 2_100n,
  alreadySettled: false,
  sender: operator,
  operator,
};
const good: SettlementReport = {
  market, chainId: 31337n, indexId: hash(1), specHash: hash(2), priceDecimals: 6,
  periodStart: 1_000n, periodEnd: 2_000n, price: 2_000_000n, publishedAt: 2_060n, evidenceHash: hash(9),
};

describe("diagnoseSettlement", () => {
  it("accepts a valid report", () => {
    expect(diagnoseSettlement(good, ctx)).toBeNull();
  });

  it("flags a stale report with the exact age", () => {
    const d = diagnoseSettlement(good, { ...ctx, blockTimestamp: 2_700n });
    expect(d?.errorName).toBe("InvalidReport");
    expect(d?.reasons[0]).toMatch(/640s/);
  });

  it("flags a report bound to another chain", () => {
    const d = diagnoseSettlement({ ...good, chainId: 10143n }, ctx);
    expect(d?.errorName).toBe("InvalidReport");
    expect(d?.reasons.join(" ")).toMatch(/chain 10143/);
  });

  it("flags a replay after settlement", () => {
    expect(diagnoseSettlement(good, { ...ctx, alreadySettled: true })?.errorName).toBe("AlreadySettled");
  });

  it("flags a report before the period ends", () => {
    expect(diagnoseSettlement(good, { ...ctx, blockTimestamp: 1_900n })?.errorName).toBe("BeforeExpiry");
  });

  it("flags a sender that is not the operator before anything else", () => {
    expect(diagnoseSettlement({ ...good, chainId: 1n }, { ...ctx, sender: stranger })?.errorName).toBe("UntrustedOperator");
  });

  it("does not check the sender when the receiver is not operator-gated", () => {
    expect(diagnoseSettlement(good, { ...ctx, sender: stranger, operator: null })).toBeNull();
  });

  it("reports every InvalidReport reason at once", () => {
    const d = diagnoseSettlement({ ...good, evidenceHash: hash(0), priceDecimals: 8 }, ctx);
    expect(d?.reasons).toHaveLength(2);
  });

  it("flags an undecodable payload", () => {
    expect(diagnoseSettlement(null, ctx)?.errorName).toBe("InvalidPayload");
  });
});

describe("diagnoseMark", () => {
  const mctx: MarkContext = {
    feed: market, chainId: 31337n, indexId: hash(1), blockTimestamp: 2_000n, marketSettled: false,
    newestObservedAt: 1_500n, sender: operator, operator,
  };
  const mark = { feed: market, chainId: 31337n, indexId: hash(1), indexPrice: 2_000_000n, observedAt: 1_900n, evidenceHash: hash(9) };

  it("accepts a fresh mark", () => {
    expect(diagnoseMark(mark, mctx)).toBeNull();
  });

  it("rejects a mark that does not advance", () => {
    expect(diagnoseMark({ ...mark, observedAt: 1_500n }, mctx)?.errorName).toBe("InvalidMark");
  });

  it("rejects marks after settlement", () => {
    expect(diagnoseMark(mark, { ...mctx, marketSettled: true })?.errorName).toBe("MarketSettled");
  });
});
