import { describe, expect, it } from "vitest";
import publicManifest from "../../../deployments/monad-testnet.public.json";
import { config, primarySubject } from "../config";
import { manifestFrom } from "../config/deployment";
import type { DeploymentManifest, PublicManifest } from "../config/types";

const pub = publicManifest as unknown as PublicManifest;
const none: Record<string, DeploymentManifest> = {};
const addressOf = (m: DeploymentManifest | null, key: string) => m?.contracts?.[key]?.address ?? null;

const keysOf = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

describe("public deployment manifest fallback", () => {
  it("builds the live series from the tracked public record when no local manifest exists", () => {
    const m = manifestFrom(none, pub, "monad-testnet", 10143, null);
    expect(m?.status).toBe("complete");
    for (const key of ["forwarder", "collateral", "settlementReceiver", "market", "markFeed", "shortFeed", "longClaim", "shortClaim"]) {
      expect(addressOf(m, key), key).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(addressOf(m, "market")).toBe("0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538");
    expect(m?.series?.mode).toBe("simulation");
  });

  it("builds the fast-demo series, which has no short feed", () => {
    const m = manifestFrom(none, pub, "monad-testnet", 10143, "fast-demo");
    expect(addressOf(m, "market")).toBe("0xb71f79e990629aD3d0aB8a3fd2A8F8a21FE0004a");
    expect(addressOf(m, "markFeed")).toBe("0x110Daf63811F8F2b50aC01a8Ab85fb9B20ca9624");
    expect(addressOf(m, "shortFeed")).toBeNull();
  });

  it("gives every deployed contract a block so the log scans start at the deployment", () => {
    const m = manifestFrom(none, pub, "monad-testnet", 10143, "fast-demo");
    expect(Math.min(...Object.values(m?.contracts ?? {}).map((c) => Number(c.blockNumber)).filter(Number.isFinite))).toBe(70365880);
  });

  it("refuses a public record for another chain or an unknown series", () => {
    expect(manifestFrom(none, pub, "monad-testnet", 1, null)).toBeNull();
    expect(manifestFrom(none, pub, "monad-testnet", 10143, "nope")).toBeNull();
    expect(manifestFrom(none, undefined, "monad-testnet", 10143, null)).toBeNull();
  });

  it("lets a complete local manifest take precedence", () => {
    const local: DeploymentManifest = { network: "monad-testnet", chainId: 10143, status: "complete", contracts: { market: { address: "0x1111111111111111111111111111111111111111" } } };
    const m = manifestFrom({ "../../../deployments/monad-testnet.json": local }, pub, "monad-testnet", 10143, null);
    expect(addressOf(m, "market")).toBe("0x1111111111111111111111111111111111111111");
  });

  it("carries no secret-looking field name", () => {
    expect(keysOf(publicManifest).filter((k) => /private|mnemonic|secret|api[_-]?key|password/i.test(k))).toEqual([]);
  });
});

describe("resolved app config (clean-clone smoke check)", () => {
  it("resolves the live market, feeds, claims and Kuru markets", () => {
    for (const key of ["market", "markFeed", "shortFeed", "longClaim", "shortClaim", "collateral", "receiver", "forwarder"] as const) {
      expect(config.contracts[key], key).not.toBeNull();
    }
    expect(config.kuru.longMarket).not.toBeNull();
    expect(config.kuru.shortMarket).not.toBeNull();
    expect(config.faucet).not.toBeUndefined();
    expect(config.deployBlock).toBe(70409788);
  });

  it("offers both series, each with its own market", () => {
    expect(config.seriesChoices.map((s) => s.id)).toEqual([null, "fast-demo"]);
    expect(config.subjects).toHaveLength(2);
    for (const subject of config.subjects) expect(subject.contracts.market, subject.label).not.toBeNull();
    expect(primarySubject.contracts.market).toBe(config.contracts.market);
  });

  it("agrees with the public record on every address it publishes", () => {
    const live = pub.liveSeries.contracts;
    const lower = (a?: string | null) => a?.toLowerCase();
    expect(lower(config.contracts.market)).toBe(lower(live.computeMarket?.address));
    expect(lower(config.contracts.markFeed)).toBe(lower(live.piryMarkFeed?.address));
    expect(lower(config.kuru.longMarket)).toBe(lower(pub.kuru.markets["PIRY-L/USDC"]?.address));
    expect(lower(config.kuru.shortMarket)).toBe(lower(pub.kuru.markets["PIRY-S/USDC"]?.address));
    expect(lower(config.kuru.accountCore)).toBe(lower(pub.kuru.accountCore));
    expect(lower(config.faucet)).toBe(lower(pub.faucet.address));
  });
});
