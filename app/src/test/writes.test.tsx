import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { Merge } from "../sections/Position";
import { MintCard } from "../sections/trade/Mint";
import { harness, OWNER_A, OWNER_B } from "./walletHarness";

const m = vi.hoisted(() => ({ allowance: 0n, collateral: 1_000_000_000n as bigint | undefined, confirmed: vi.fn() }));

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/viewer", async () => (await import("./walletHarness")).viewerMock);
vi.mock("../hooks/chain", async () => ({
  ...(await import("./walletHarness")).chainMock,
  useChainNow: () => 1000n,
  useMarket: () => ({ dataUpdatedAt: 0 }),
  useHolder: () => ({ data: m.collateral === undefined ? undefined : { collateral: m.collateral, collateralAllowance: m.allowance } }),
}));
vi.mock("../lib/kuru", async (original) => ({ ...(await original<typeof import("../lib/kuru")>()), confirmed: (...args: unknown[]) => m.confirmed(...args) }));

const snapshot = {
  address: "0x5555555555555555555555555555555555555555",
  block: { number: 1n, timestamp: 1000n },
  terms: { periodEnd: 5000n },
  collateral: { address: config.kuru.quoteToken, symbol: "USDC", decimals: 6 },
  claims: { longSymbol: "PIRY-L", shortSymbol: "PIRY-S", decimals: 6 },
} as never;
const wrap = (node: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
const functionNames = () => harness.client.simulateContract.mock.calls.map((call) => (call[0] as { functionName: string }).functionName);

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  m.allowance = 0n;
  m.collateral = 1_000_000_000n;
  m.confirmed.mockImplementation(async () => ({ status: "success" }));
});
afterEach(cleanup);

describe("mint", () => {
  it("switches a wallet on another chain, then approves and mints from the connected account", async () => {
    render(wrap(<MintCard snapshot={snapshot} />));
    const mint = screen.getByRole("button", { name: "Mint pair" });
    harness.chainId = 1;
    fireEvent.click(mint);
    await waitFor(() => expect(harness.write).toHaveBeenCalledTimes(2));
    expect(harness.switchChain).toHaveBeenCalledWith(10143);
    expect(functionNames()).toEqual(["approve", "mintPairs"]);
    expect(harness.client.simulateContract.mock.calls[1]![0]).toMatchObject({ account: { address: OWNER_A }, args: [100_000_000n] });
    expect(screen.queryByText(/Connect a wallet first/)).toBeNull();
  });

  it("skips the approval when the allowance already covers the amount", async () => {
    m.allowance = 100_000_000n;
    render(wrap(<MintCard snapshot={snapshot} />));
    fireEvent.click(screen.getByRole("button", { name: "Mint pair" }));
    await waitFor(() => expect(harness.write).toHaveBeenCalledTimes(1));
    expect(functionNames()).toEqual(["mintPairs"]);
  });

  it("does not mint after the approval when the wallet switched while it confirmed", async () => {
    let release: () => void = () => {};
    m.confirmed.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ status: "success" }))));
    const { rerender } = render(wrap(<MintCard snapshot={snapshot} />));
    fireEvent.click(screen.getByRole("button", { name: "Mint pair" }));
    await waitFor(() => expect(m.confirmed).toHaveBeenCalled());
    harness.address = OWNER_B;
    rerender(wrap(<MintCard snapshot={snapshot} />));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(functionNames()).toEqual(["approve"]);
  });
});

describe("mint amount", () => {
  const amountField = () => screen.getByLabelText(/^Collateral to deposit/) as HTMLInputElement;

  it("defaults to 100 when the balance covers it or is unknown", () => {
    render(wrap(<MintCard snapshot={snapshot} />));
    expect(amountField().value).toBe("100");
    cleanup();
    m.collateral = undefined;
    render(wrap(<MintCard snapshot={snapshot} />));
    expect(amountField().value).toBe("100");
  });

  it("defaults to the balance when that is below 100, and to empty when it is zero", () => {
    m.collateral = 37_500_000n;
    render(wrap(<MintCard snapshot={snapshot} />));
    expect(amountField().value).toBe("37.5");
    cleanup();
    m.collateral = 0n;
    render(wrap(<MintCard snapshot={snapshot} />));
    expect(amountField().value).toBe("");
  });

  it.each([
    ["", "Enter an amount."],
    ["0", "Enter an amount."],
    ["abc", "Enter a valid amount."],
    ["-5", "Enter a valid amount."],
    ["1.1234567", "Use at most 6 decimal places."],
    ["1001", "More than your USDC balance."],
  ])("says what is wrong with %j", (value, message) => {
    render(wrap(<MintCard snapshot={snapshot} />));
    fireEvent.change(amountField(), { target: { value: "1" } });
    fireEvent.change(amountField(), { target: { value } });
    if (value === "") {
      expect(screen.getByRole("button", { name: "Mint pair" }).hasAttribute("disabled")).toBe(true);
      return;
    }
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.getByRole("button", { name: "Mint pair" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("merge", () => {
  it("merges to the connected account after switching the wallet to the app chain", async () => {
    render(wrap(<Merge snapshot={snapshot} pairs={5_000_000n} />));
    fireEvent.change(screen.getByLabelText(/^Pairs to merge/), { target: { value: "2" } });
    const merge = screen.getByRole("button", { name: "Merge pairs" });
    harness.chainId = 1;
    fireEvent.click(merge);
    await waitFor(() => expect(harness.write).toHaveBeenCalledTimes(1));
    expect(harness.switchChain).toHaveBeenCalledWith(10143);
    expect(harness.client.simulateContract.mock.calls[0]![0]).toMatchObject({ functionName: "mergePairs", args: [2_000_000n, OWNER_A] });
  });
});
