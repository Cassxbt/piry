import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedeemForm } from "../sections/Redeem";
import { harness, OWNER_A } from "./walletHarness";

const m = vi.hoisted(() => ({ held: { long: 1n, short: 1n, collateral: 0n }, preview: 0n }));

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/viewer", async () => (await import("./walletHarness")).viewerMock);
vi.mock("../hooks/chain", async () => ({ ...(await import("./walletHarness")).chainMock, useHolder: () => ({ data: m.held }), useMarket: () => ({}) }));

const snapshot = {
  address: "0x2222222222222222222222222222222222222222",
  block: { number: 1n, timestamp: 1000n },
  terms: { lower: 2_000_000n, upper: 4_000_000n, priceDecimals: 6 },
  state: { settled: true, settlementPrice: 3_000_000n },
  claims: { decimals: 6, longSymbol: "PIRY-L", shortSymbol: "PIRY-S" },
  collateral: { decimals: 6, symbol: "USDC" },
} as never;
const ui = () => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RedeemForm snapshot={snapshot} />
  </QueryClientProvider>
);
const redeem = () => screen.getByRole("button", { name: "Redeem" }) as HTMLButtonElement;
const ack = () => screen.getByRole("checkbox", { name: /burn .* for nothing/i });

beforeEach(() => {
  harness.reset();
  m.held = { long: 1n, short: 1n, collateral: 0n };
  m.preview = 0n;
  harness.client.readContract.mockImplementation(async () => m.preview);
});
afterEach(cleanup);

describe("redeem with a zero-output preview", () => {
  it("is refused by default and suggests merging the matched pair", async () => {
    render(ui());
    await waitFor(() => expect(screen.getByText(/pays nothing/i)).toBeTruthy());
    expect(redeem().disabled).toBe(true);
    const link = screen.getByRole("link", { name: /merge/i });
    expect(link.getAttribute("href")).toBe("#position");
    fireEvent.click(redeem());
    expect(harness.client.simulateContract).not.toHaveBeenCalled();
  });

  it("burns only after an explicit acknowledgment, with the minimum the user chose", async () => {
    render(ui());
    await waitFor(() => expect(screen.getByText(/pays nothing/i)).toBeTruthy());
    fireEvent.click(ack());
    expect(redeem().disabled).toBe(false);
    fireEvent.click(redeem());
    await waitFor(() => expect(harness.write).toHaveBeenCalled());
    expect(harness.client.simulateContract.mock.calls.at(-1)?.[0]).toMatchObject({ functionName: "redeem", args: [1n, 1n, OWNER_A, 0n] });
  });

  it("asks again when the amounts change after acknowledging", async () => {
    m.held = { long: 5n, short: 1n, collateral: 0n };
    render(ui());
    await waitFor(() => expect(screen.getByText(/pays nothing/i)).toBeTruthy());
    fireEvent.click(ack());
    expect(redeem().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^PIRY-L to redeem/), { target: { value: "0.000003" } });
    await waitFor(() => expect(redeem().disabled).toBe(true));
  });

  it("does not suggest a merge for a single losing leg, but still requires the acknowledgment", async () => {
    m.held = { long: 5n, short: 0n, collateral: 0n };
    render(ui());
    await waitFor(() => expect(screen.getByText(/pays nothing/i)).toBeTruthy());
    expect(screen.queryByRole("link", { name: /merge/i })).toBeNull();
    expect(redeem().disabled).toBe(true);
    fireEvent.click(ack());
    expect(redeem().disabled).toBe(false);
  });

  it("needs no acknowledgment when the preview pays something", async () => {
    m.preview = 250_000n;
    render(ui());
    await waitFor(() => expect(redeem().disabled).toBe(false));
    expect(screen.queryByText(/pays nothing/i)).toBeNull();
  });
});
