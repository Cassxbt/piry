import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import fixture from "./fixtures/composite-evidence.json";
import { checkEvidence, hashEvidence, type EvidenceTarget } from "../lib/evidence";

vi.mock("../sections/evidence/Ledger", () => ({ Ledger: () => null }));
vi.mock("../sections/evidence/Lifecycle", () => ({ Lifecycle: () => null }));
vi.mock("../sections/evidence/Rounds", () => ({ Rounds: () => null }));

const { EvidencePanel } = await import("../sections/Evidence");
const { useEvidenceFile } = await import("../hooks/chain");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const indexId = `0x${"11".repeat(32)}` as Hex;
const specHash = `0x${"22".repeat(32)}` as Hex;
const demoTarget = (text: string): EvidenceTarget => ({
  evidenceHash: hashEvidence(text), price: 3_000_000n, indexId, specHash, periodStart: 100n, periodEnd: 220n, publishedAt: 230n, minSources: null,
});
const snapshot = {
  address: "0x2222222222222222222222222222222222222222",
  block: { number: 1n, timestamp: 1000n },
  terms: { lower: 2_000_000n, upper: 4_000_000n, priceDecimals: 6, periodStart: 100n, periodEnd: 220n, indexId, specHash },
  state: { settled: true, settlementPrice: 3_000_000n, evidenceHash: hashEvidence("x") },
  claims: { decimals: 6 },
  collateral: { decimals: 6, symbol: "USDC" },
} as never;
const subject = { id: null, evidenceBase: "/evidence/monad-testnet", series: { dataMode: "DEMO" } } as never;

describe("EvidencePanel", () => {
  it("shows the no-gaps check as failed for duplicated slots with an omitted slot", () => {
    const dataset = {
      mode: "DEMO", sourceId: "demo", datasetId: "demo", hardware: { model: "H100", region: "demo" }, units: "USD", indexId, specHash,
      periodStart: 100, periodEnd: 220, slotSeconds: 60, publishedAt: 230,
      observations: [{ slotStart: 100, observedAt: 100, price: "3000000" }, { slotStart: 100, observedAt: 101, price: "3000000" }],
    };
    const text = JSON.stringify({ methodology: "equal-slot-mean-floor-v1", dataset });
    const check = checkEvidence(text, demoTarget(text));
    render(<EvidencePanel snapshot={snapshot} subject={subject} text={text} check={check} url="/evidence/x.json" />);
    expect(screen.getByText(/Every slot of the period appears exactly once/).closest(".check")?.className).toBe("check fail");
    expect(screen.getByText("Verification failed")).toBeTruthy();
  });

  it("labels an unsupported methodology reported but not verified, never as a price match", () => {
    const text = JSON.stringify({ methodology: "invented", dataset: { observations: [{ price: "5", slotStart: 0, observedAt: 1 }] } });
    const check = checkEvidence(text, demoTarget(text));
    render(<EvidencePanel snapshot={snapshot} subject={subject} text={text} check={check} url="/evidence/x.json" />);
    expect(screen.getByText("Reported but not verified")).toBeTruthy();
    expect(screen.queryByText(/reproduces the settled price/)).toBeNull();
  });

  it("shows the composite sources and says the snapshot time is fetch time", () => {
    const check = checkEvidence(fixture.fourSources.text, {
      evidenceHash: fixture.fourSources.hash as Hex, price: 3_388_500n, indexId, specHash: fixture.specHash as Hex,
      periodStart: 0n, periodEnd: BigInt(fixture.periodEnd), publishedAt: BigInt(fixture.fourSources.publishedAt) - 15n, minSources: 3,
    });
    render(<EvidencePanel snapshot={snapshot} subject={subject} text={fixture.fourSources.text} check={check} url="/evidence/composite/x.json" />);
    expect(screen.getByText("Verified in your browser")).toBeTruthy();
    expect(screen.getByText("Shadeform")).toBeTruthy();
    expect(screen.getByText(/not a measurement time published by the providers/)).toBeTruthy();
  });
});

describe("useEvidenceFile", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );
  const settled = {
    address: "0x2222222222222222222222222222222222222222",
    terms: { indexId, specHash: fixture.specHash as Hex, periodStart: 0n, periodEnd: BigInt(fixture.periodEnd) },
    state: { settled: true, settledByFallback: false, settlementPrice: 3_388_500n, evidenceHash: fixture.fourSources.hash as Hex, reportPublishedAt: BigInt(fixture.fourSources.publishedAt) },
  } as never;
  const live = { id: null, evidenceBase: "/evidence/monad-testnet", series: { dataMode: "LIVE", source: { minValid: 3 } } } as never;

  it("looks the file up by the on-chain hash, reports unavailable when it is absent, and recovers once it is published", async () => {
    const urls: string[] = [];
    let published = false;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return published && url.endsWith(`${fixture.fourSources.hash}.json`)
        ? { ok: true, text: async () => fixture.fourSources.text }
        : { ok: false, text: async () => "" };
    });
    const { result } = renderHook(() => useEvidenceFile(settled, live), { wrapper });
    await waitFor(() => expect(result.current.data?.state).toBe("unavailable"));
    expect(urls[0]).toBe(`/evidence/composite/${fixture.fourSources.hash}.json`);
    expect(result.current.isStale).toBe(true);

    published = true;
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.state).toBe("verified"));
    expect(result.current.isStale).toBe(false);
  });
});
