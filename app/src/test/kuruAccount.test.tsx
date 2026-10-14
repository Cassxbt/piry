import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { KuruAccount } from "../sections/trade/KuruAccount";
import { harness, HASH, OWNER_A } from "./walletHarness";

const m = vi.hoisted(() => ({
  freshness: { state: "fresh", ageSeconds: 60 } as { state: string; ageSeconds: number | null },
  open: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/viewer", async () => (await import("./walletHarness")).viewerMock);
vi.mock("../hooks/chain", async () => (await import("./walletHarness")).chainMock);
vi.mock("../hooks/markFreshness", async (original) => ({ ...(await original<typeof import("../hooks/markFreshness")>()), useMarkFreshness: () => m.freshness }));
vi.mock("../hooks/kuru", () => ({
  kuruMarketFor: () => null,
  useKuruAccount: () => ({
    data: {
      block: 4_321n,
      rootId: 7n,
      balances: [config.kuru.quoteToken, "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"].map((token) => ({ token, free: 900_000_000n, reserved: 0n })),
    },
  }),
  useWalletTokens: () => ({
    data: Object.fromEntries([config.kuru.quoteToken, "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"].map((t) => [t.toLowerCase(), 900_000_000n])),
  }),
  useOpenOrders: () => ({ data: [], isLoading: false }),
}));
vi.mock("../lib/kuru", () => ({
  openSession: (...args: unknown[]) => m.open(...args),
  depositToKuru: (...args: unknown[]) => m.deposit(...args),
  withdrawFromKuru: (...args: unknown[]) => m.withdraw(...args),
  cancelSlots: vi.fn(),
}));

const snapshot = {
  claims: {
    long: "0x3333333333333333333333333333333333333333",
    short: "0x4444444444444444444444444444444444444444",
    longSymbol: "PIRY-L",
    shortSymbol: "PIRY-S",
    decimals: 6,
  },
} as never;
const ui = () => (
  <QueryClientProvider client={new QueryClient()}>
    <KuruAccount snapshot={snapshot} />
  </QueryClientProvider>
);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const pick = (symbol: string) => fireEvent.click(screen.getByRole("button", { name: symbol, pressed: false }));
const enter = (value: string) => fireEvent.change(screen.getByLabelText(/^Amount of/), { target: { value } });

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  m.freshness = { state: "fresh", ageSeconds: 60 };
  m.open.mockImplementation(async (_pc: unknown, wallet: unknown) => ({ wallet }));
  m.deposit.mockImplementation(async () => HASH);
  m.withdraw.mockImplementation(async () => HASH);
});
afterEach(cleanup);

describe("claim deposits and withdrawals against Kuru's price-age limiter", () => {
  it.each([
    ["stale", 2400],
    ["unknown", null],
  ])("disables both claim buttons with an explanation when the mark is %s", (state, ageSeconds) => {
    m.freshness = { state, ageSeconds };
    render(ui());
    pick("PIRY-L");
    enter("5");
    expect(button("Deposit PIRY-L").disabled).toBe(true);
    expect(button("Withdraw PIRY-L").disabled).toBe(true);
    expect(screen.getByText(state === "stale" ? /Stale mark/ : /cannot be read/)).toBeTruthy();
  });

  it("blocks the short claim the same way", () => {
    m.freshness = { state: "stale", ageSeconds: 2400 };
    render(ui());
    pick("PIRY-S");
    enter("5");
    expect(button("Deposit PIRY-S").disabled).toBe(true);
    expect(button("Withdraw PIRY-S").disabled).toBe(true);
  });

  it("never blocks quote-token actions on claim freshness", () => {
    m.freshness = { state: "stale", ageSeconds: 2400 };
    render(ui());
    enter("5");
    expect(button("Deposit USDC").disabled).toBe(false);
    expect(button("Withdraw USDC").disabled).toBe(false);
    expect(screen.queryByText(/Stale mark/)).toBeNull();
  });

  it.each(["fresh", "final"])("leaves claim buttons enabled for a %s mark", (state) => {
    m.freshness = { state, ageSeconds: 10 };
    render(ui());
    pick("PIRY-L");
    enter("5");
    expect(button("Deposit PIRY-L").disabled).toBe(false);
    expect(button("Withdraw PIRY-L").disabled).toBe(false);
  });
});

describe("Kuru writes", () => {
  it("withdraws from the connected account after switching the wallet to the app chain", async () => {
    render(ui());
    pick("PIRY-L");
    enter("5");
    const withdraw = button("Withdraw PIRY-L");
    harness.chainId = 1;
    fireEvent.click(withdraw);
    await waitFor(() => expect(m.withdraw).toHaveBeenCalled());
    expect(harness.switchChain).toHaveBeenCalledWith(10143);
    expect(harness.walletClient).toHaveBeenCalledWith(10143, OWNER_A);
    const [, token, amount, guard] = m.withdraw.mock.calls[0]!;
    expect(token).toBe("0x3333333333333333333333333333333333333333");
    expect(amount).toBe(5_000_000n);
    expect(guard).toBeTypeOf("function");
  });

  it("hands the deposit a guard so it can stop between the approval and the deposit", async () => {
    render(ui());
    enter("5");
    fireEvent.click(button("Deposit USDC"));
    await waitFor(() => expect(m.deposit).toHaveBeenCalled());
    expect(m.deposit.mock.calls[0]![3]).toBeTypeOf("function");
  });
});

describe("balance badge", () => {
  it("says the balances were fetched near a block instead of claiming a snapshot at it", () => {
    render(ui());
    expect(screen.getByText(/fetched near block 4,321/)).toBeTruthy();
    expect(screen.queryByText(/^block 4,321$/)).toBeNull();
  });
});

describe("balance limits", () => {
  it("says why both buttons are off when the amount is above every balance", () => {
    render(ui());
    enter("1000");
    expect(button("Deposit USDC").disabled).toBe(true);
    expect(button("Withdraw USDC").disabled).toBe(true);
    expect(screen.getAllByText("More than your available USDC.").length).toBeGreaterThan(0);
  });

  it("clears a confirmed deposit when another token is picked", async () => {
    render(ui());
    enter("5");
    fireEvent.click(button("Deposit USDC"));
    await waitFor(() => expect(screen.getByText(/Deposit confirmed/)).toBeTruthy());
    pick("PIRY-L");
    expect(screen.queryByText(/Deposit confirmed/)).toBeNull();
  });
});
