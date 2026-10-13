import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import demoEvidence from "../../public/evidence/monad-testnet/fast-demo/evidence.json";
import fixture from "./fixtures/composite-evidence.json";
import { canonicalJson, checkEvidence, evidenceUrls, hashEvidence, medianFloor, type EvidenceTarget } from "../lib/evidence";

const demoText = JSON.stringify(demoEvidence);
const demoTarget: EvidenceTarget = {
  evidenceHash: "0xdcc0360271a9015678c35c2774f19deaf7f843a36b06c4a9dee46ade945bc4ff",
  price: 2658755n,
  indexId: "0xc4d3fe4c512534f9f122bef9287df54bad47ae35d4e8e5a7e1dd37afa8ed9d60",
  specHash: "0xddcbab98d4239deca920f2b907b3f5f7264a1808851f9e48bb05e809575ffbbd",
  periodStart: 1791798853n,
  periodEnd: 1791799153n,
  publishedAt: 1791799172n,
  minSources: null,
};

const four = fixture.fourSources;
const three = fixture.threeSources;
const compositeTarget = (over: Partial<EvidenceTarget> = {}, sample = four): EvidenceTarget => ({
  evidenceHash: sample.hash as Hex,
  price: BigInt(sample.price),
  indexId: fixture.indexId as Hex,
  specHash: fixture.specHash as Hex,
  periodStart: BigInt(fixture.periodEnd - 86400),
  periodEnd: BigInt(fixture.periodEnd),
  publishedAt: BigInt(sample.publishedAt),
  minSources: 3,
  ...over,
});
const failed = (check: ReturnType<typeof checkEvidence>) => check.checks.filter((c) => c.state === "fail").map((c) => c.id);

describe("composite-median-v1 evidence", () => {
  it("verifies evidence produced by the workflow: hash, canonical form, quorum, median, bindings", () => {
    const check = checkEvidence(four.text, compositeTarget());
    expect(check.state).toBe("verified");
    expect(check.priceMatches).toBe(true);
    expect(check.computedPrice).toBe(3388500n);
    expect(check.checks.every((c) => c.state === "pass")).toBe(true);
  });

  it("verifies a three-source quorum with its integer median, and fails it against a four-source minimum", () => {
    expect(checkEvidence(three.text, compositeTarget({}, three)).state).toBe("verified");
    expect(checkEvidence(three.text, compositeTarget({}, three)).computedPrice).toBe(2730000n);
    const strict = checkEvidence(three.text, compositeTarget({ minSources: 4 }, three));
    expect(strict.state).toBe("failed");
    expect(failed(strict)).toEqual(["quorum"]);
  });

  it("uses the workflow's rounding for an even count: floor of the mean of the two middle values", () => {
    expect(medianFloor([3n, 1n, 2n, 4n])).toBe(2n);
    expect(medianFloor([1n, 2n])).toBe(1n);
    expect(medianFloor([5n])).toBe(5n);
    expect(medianFloor([])).toBeNull();
  });

  it("fails when one price byte changes, even if the on-chain hash is also replaced", () => {
    const tampered = four.text.replace("2730000", "2730002");
    expect(failed(checkEvidence(tampered, compositeTarget()))).toContain("hash");
    const rehashed = checkEvidence(tampered, compositeTarget({ evidenceHash: hashEvidence(tampered) }));
    expect(rehashed.state).toBe("failed");
    expect(failed(rehashed)).toEqual(["median"]);
  });

  it("fails when a source is removed or the text is not the canonical form", () => {
    const removed = JSON.stringify({ ...JSON.parse(four.text), sources: { ...JSON.parse(four.text).sources, verda: undefined } });
    const missing = checkEvidence(removed, compositeTarget({ evidenceHash: hashEvidence(removed) }));
    expect(missing.state).toBe("failed");
    expect(failed(missing)).toContain("canonical");
    const pretty = JSON.stringify(JSON.parse(four.text), null, 2);
    expect(failed(checkEvidence(pretty, compositeTarget({ evidenceHash: hashEvidence(pretty) })))).toContain("canonical");
  });

  it("fails evidence bound to another series or observed outside the settlement", () => {
    const other = checkEvidence(four.text, compositeTarget({ specHash: `0x${"11".repeat(32)}` }));
    expect(other.state).toBe("failed");
    expect(failed(other)).toEqual(["bound"]);
    expect(failed(checkEvidence(four.text, compositeTarget({ publishedAt: BigInt(four.publishedAt) + 60n })))).toEqual(["observed"]);
    expect(failed(checkEvidence(four.text, compositeTarget({ periodEnd: BigInt(four.publishedAt) + 60n })))).toEqual(["observed"]);
  });

  it("accepts the report's publishedAt up to the workflow's time margin before the evidence's observedAt, but not later", () => {
    const at = BigInt(four.publishedAt);
    expect(checkEvidence(four.text, compositeTarget({ publishedAt: at - 15n })).state).toBe("verified");
    expect(failed(checkEvidence(four.text, compositeTarget({ publishedAt: at - 61n })))).toEqual(["observed"]);
    expect(failed(checkEvidence(four.text, compositeTarget({ publishedAt: at + 1n })))).toEqual(["observed"]);
  });

  it("fails when the settled price is not the median", () => {
    expect(failed(checkEvidence(four.text, compositeTarget({ price: 3388501n })))).toEqual(["median"]);
  });

  it("canonicalJson sorts keys at every depth like the workflow", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson(JSON.parse(four.text))).toBe(four.text);
  });
});

describe("equal-slot-mean-floor-v1 evidence (DEMO)", () => {
  it("verifies the recorded fast-demo evidence", () => {
    const check = checkEvidence(demoText, demoTarget);
    expect(check.state).toBe("verified");
    expect(check.priceMatches).toBe(true);
  });

  it("fails duplicated slots with a gap even though the observation count is right", () => {
    const dataset = {
      mode: "DEMO", indexId: demoTarget.indexId, specHash: demoTarget.specHash, periodStart: 100, periodEnd: 220, slotSeconds: 60, publishedAt: 230,
      observations: [{ slotStart: 100, observedAt: 100, price: "3000000" }, { slotStart: 100, observedAt: 101, price: "3000000" }],
    };
    const text = JSON.stringify({ methodology: "equal-slot-mean-floor-v1", dataset });
    const check = checkEvidence(text, { ...demoTarget, evidenceHash: hashEvidence(text), price: 3000000n, periodStart: 100n, periodEnd: 220n, publishedAt: 230n });
    expect(check.state).toBe("failed");
    expect(failed(check)).toEqual(["coverage"]);
  });

  it("fails reordered or misaligned slots and slots observed outside their window", () => {
    const base = JSON.parse(demoText);
    const reorder = (mutate: (o: { slotStart: number; observedAt: number; price: string }[]) => void) => {
      const copy = structuredClone(base);
      mutate(copy.dataset.observations);
      const text = JSON.stringify(copy);
      return checkEvidence(text, { ...demoTarget, evidenceHash: hashEvidence(text) });
    };
    expect(failed(reorder((o) => o.reverse()))).toEqual(["coverage"]);
    expect(failed(reorder((o) => { o[1]!.slotStart += 1; }))).toEqual(["coverage"]);
    expect(failed(reorder((o) => { o[2]!.observedAt = o[2]!.slotStart + 3600; }))).toEqual(["coverage"]);
  });

  it("fails a changed price, another series, or a report published at a different time", () => {
    expect(failed(checkEvidence(demoText.replace("2465654", "2465655"), demoTarget))).toContain("hash");
    expect(failed(checkEvidence(demoText, { ...demoTarget, specHash: `0x${"22".repeat(32)}` }))).toEqual(["bound"]);
    expect(failed(checkEvidence(demoText, { ...demoTarget, publishedAt: 1791799173n }))).toEqual(["observed"]);
    expect(failed(checkEvidence(demoText, { ...demoTarget, periodEnd: 1791799213n }))).toContain("bound");
  });
});

describe("unsupported and malformed evidence", () => {
  it("never reports a price match for an unknown methodology", () => {
    const text = JSON.stringify({ methodology: "invented", dataset: { observations: [{ price: "5", slotStart: 0, observedAt: 1 }] } });
    const check = checkEvidence(text, { ...demoTarget, evidenceHash: hashEvidence(text), price: 5n });
    expect(check.state).toBe("unverified");
    expect(check.supported).toBe(false);
    expect(check.priceMatches).toBeNull();
    expect(check.checks.find((c) => c.id === "hash")?.state).toBe("pass");
  });

  it("is failed, not unverified, when the bytes do not hash to the on-chain value", () => {
    const text = JSON.stringify({ methodology: "invented" });
    expect(checkEvidence(text, demoTarget).state).toBe("failed");
  });

  it("fails text that is not JSON without throwing", () => {
    const check = checkEvidence("not json", { ...demoTarget, evidenceHash: hashEvidence("not json") });
    expect(check.state).toBe("failed");
    expect(check.parseError).not.toBeNull();
  });
});

describe("evidenceUrls", () => {
  const hash = `0x${"ab".repeat(32)}` as Hex;
  it("looks live composite evidence up by the on-chain hash, and DEMO evidence by its series folder", () => {
    expect(evidenceUrls("/evidence/monad-testnet", "LIVE", hash)).toEqual([`/evidence/composite/${hash}.json`, `/evidence/composite/${"ab".repeat(32)}.json`]);
    expect(evidenceUrls("/evidence/monad-testnet/fast-demo", "DEMO", hash)).toEqual(["/evidence/monad-testnet/fast-demo/evidence.json"]);
  });
});
