import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { Ticket } from "../sections/trade/Ticket";
import { harness, HASH, OWNER_A, OWNER_B } from "./walletHarness";

const m = vi.hoisted(() => ({
  quote: { amountInUsed: 10_000_000n, amountOut: 20_000_000n },
  moved: null as null | { amountInUsed: bigint; amountOut: bigint },
  estimate: vi.fn(),
  open: vi.fn(),
  swap: vi.fn(),
  limit: vi.fn(),
  outcome: vi.fn(),
  freshness: { state: "fresh", ageSeconds: 60 } as { state: string; ageSeconds: number | null },
}));

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/viewer", async () => (await import("./walletHarness")).viewerMock);
vi.mock("../hooks/chain", async () => (await import("./walletHarness")).chainMock);
vi.mock("../hooks/markFreshness", async (original) => ({ ...(await original<typeof import("../hooks/markFreshness")>()), useMarkFreshness: () => m.freshness }));
vi.mock("../hooks/kuru", () => ({
  kuruMarketFor: () => "0x2222222222222222222222222222222222222222",
  useKuruAccount: () => ({
    data: {
      rootId: 7n,
      balances: [
        { token: config.kuru.quoteToken, free: 500_000_000n },
        { token: "0x3333333333333333333333333333333333333333", free: 500_000_000n },
      ],
    },
  }),
}));
vi.mock("../lib/kuru", () => ({
  estimateSwap: (...args: unknown[]) => m.estimate(...args),
  openSession: (...args: unknown[]) => m.open(...args),
  placeSwap: (...args: unknown[]) => m.swap(...args),
  placeLimit: (...args: unknown[]) => m.limit(...args),
  describeOutcome: (...args: unknown[]) => m.outcome(...args),
}));

const snapshot = {
  address: "0x5555555555555555555555555555555555555555",
  claims: { long: "0x3333333333333333333333333333333333333333", longSymbol: "PIRY-L", shortSymbol: "PIRY-S" },
} as never;
const book = {
  scale: { baseDecimals: 6, quoteDecimals: 6, sizePrecision: 1n, pricePrecision: 10000n, tickSize: 1n, minQuote: 1_000_000n, maxQuote: 10_000_000_000n },
  fees: { makerPps: 2000n, takerPps: 7000n },
} as never;

const ui = (defaultBuy = true) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Ticket snapshot={snapshot} book={book} side="long" defaultBuy={defaultBuy} />
  </QueryClientProvider>
);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
async function enterAmount(value: string, label = /^Spend/) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await waitFor(() => expect(screen.getByText(/^Minimum accepted/).nextElementSibling?.textContent).not.toBe("-"));
}

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  m.quote = { amountInUsed: 10_000_000n, amountOut: 20_000_000n };
  m.moved = null;
  m.freshness = { state: "fresh", ageSeconds: 60 };
  m.estimate.mockImplementation(async () => m.moved ?? m.quote);
  m.open.mockImplementation(async (_pc: unknown, wallet: { account: { address: string } }) => ({ owner: wallet.account.address }));
  m.swap.mockImplementation(async () => HASH);
  m.limit.mockImplementation(async () => HASH);
  m.outcome.mockImplementation(async () => ({ label: "FILLED", fills: 1, filledSize: 20n, restingSize: 0n }));
});
afterEach(cleanup);

describe("market buy with a partial quote", () => {
  it("sends only the input the quote used, with the floor derived from that amount", async () => {
    render(ui());
    await enterAmount("100");
    expect(screen.getByText(/Partial fill/)).toBeTruthy();
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
    expect(m.swap.mock.calls.at(-1)?.[1]).toMatchObject({ isBuy: true, amountIn: 10_000_000n, minAmountOut: 19_900_000n });
  });

  it("re-estimates the amount it is about to send, right before sending", async () => {
    render(ui());
    await enterAmount("100");
    const before = m.estimate.mock.calls.length;
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
    expect(m.estimate.mock.calls.length).toBeGreaterThan(before);
    expect(m.estimate.mock.calls.some((call) => call[3] === 10_000_000n)).toBe(true);
  });

  it("refuses, and sends nothing, when the book got worse beyond the tolerance since the estimate", async () => {
    render(ui());
    await enterAmount("100");
    m.moved = { amountInUsed: 10_000_000n, amountOut: 10_000_000n };
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(screen.getByText(/The book moved/)).toBeTruthy());
    expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
    expect(m.swap).not.toHaveBeenCalled();
  });

  it("still sends when the refreshed book is within tolerance or better", async () => {
    render(ui());
    await enterAmount("100");
    m.moved = { amountInUsed: 10_000_000n, amountOut: 19_950_000n };
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
  });

  it("sends the whole input and shows no partial notice when the book takes all of it", async () => {
    m.quote = { amountInUsed: 100_000_000n, amountOut: 200_000_000n };
    render(ui());
    await enterAmount("100");
    expect(screen.queryByText(/Partial fill/)).toBeNull();
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
    expect(m.swap.mock.calls.at(-1)?.[1]).toMatchObject({ amountIn: 100_000_000n, minAmountOut: 199_000_000n });
  });
});

describe("market sell with a partial quote", () => {
  beforeEach(() => {
    m.quote = { amountInUsed: 30_000_000n, amountOut: 15_000_000n };
  });

  it("sends only the claims the book can absorb, with proceeds floored on that amount", async () => {
    render(ui(false));
    await enterAmount("100", /^Sell/);
    fireEvent.click(button("Market sell PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
    expect(m.swap.mock.calls.at(-1)?.[1]).toMatchObject({ isBuy: false, amountIn: 30_000_000n, minAmountOut: 14_925_000n });
  });

  it("refuses when the proceeds fell below the floor by submission", async () => {
    render(ui(false));
    await enterAmount("100", /^Sell/);
    m.moved = { amountInUsed: 30_000_000n, amountOut: 9_000_000n };
    fireEvent.click(button("Market sell PIRY-L"));
    await waitFor(() => expect(screen.getByText(/The book moved/)).toBeTruthy());
    expect(m.swap).not.toHaveBeenCalled();
  });
});

describe("operation identity", () => {
  it("does not place the order, or show its outcome, when the wallet switches while the session opens", async () => {
    let release: () => void = () => {};
    m.open.mockImplementation(
      (_pc: unknown, wallet: { account: { address: string } }) => new Promise((resolve) => (release = () => resolve({ owner: wallet.account.address }))),
    );
    const { rerender } = render(ui());
    await enterAmount("100");
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.open).toHaveBeenCalled());
    harness.address = OWNER_B;
    rerender(ui());
    release();
    await waitFor(() => expect(harness.walletClient).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.swap).not.toHaveBeenCalled();
    expect(screen.queryByText(/Market outcome/)).toBeNull();
    expect(harness.walletClient).toHaveBeenCalledWith(10143, OWNER_A);
  });

  it("ignores a second click while the first order is still in flight", async () => {
    let release: () => void = () => {};
    m.open.mockImplementation(
      (_pc: unknown, wallet: { account: { address: string } }) => new Promise((resolve) => (release = () => resolve({ owner: wallet.account.address }))),
    );
    render(ui());
    await enterAmount("100");
    const buy = button("Market buy PIRY-L");
    fireEvent.click(buy);
    fireEvent.click(buy);
    await waitFor(() => expect(m.open).toHaveBeenCalled());
    release();
    await waitFor(() => expect(m.swap).toHaveBeenCalledTimes(1));
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  it("does not place the order when the series settled between the click and the write", async () => {
    harness.client.readContract.mockImplementation(async () => true);
    render(ui());
    await enterAmount("100");
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(screen.getByText(/has settled/)).toBeTruthy());
    expect(m.swap).not.toHaveBeenCalled();
  });

  it("applies the same settled check to limit orders", async () => {
    harness.client.readContract.mockImplementation(async () => true);
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText(/^Limit price/), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: "10" } });
    await waitFor(() => expect(button("Limit buy PIRY-L").disabled).toBe(false));
    fireEvent.click(button("Limit buy PIRY-L"));
    await waitFor(() => expect(screen.getByText(/has settled/)).toBeTruthy());
    expect(m.limit).not.toHaveBeenCalled();
  });

  it("keeps the confirmed transaction hash when the outcome cannot be decoded", async () => {
    m.outcome.mockRejectedValue(new Error("unknown event"));
    render(ui());
    await enterAmount("100");
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(screen.getByText(/outcome could not be decoded/)).toBeTruthy());
    expect(screen.getByText(/Market buy confirmed/)).toBeTruthy();
    expect(screen.queryByText(/Market outcome/)).toBeNull();
  });

  it("shows the decoded outcome for the matching wallet", async () => {
    render(ui());
    await enterAmount("100");
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(screen.getByText(/Market outcome: FILLED/)).toBeTruthy());
  });
});

describe("buying while claims cannot be withdrawn", () => {
  it.each(["stale", "unknown"])("requires an acknowledgment before a buy when the mark is %s", async (state) => {
    m.freshness = { state, ageSeconds: state === "stale" ? 2400 : null };
    render(ui());
    await enterAmount("100");
    expect(screen.getByText(/may not be able to withdraw/i)).toBeTruthy();
    expect(button("Market buy PIRY-L").disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(button("Market buy PIRY-L").disabled).toBe(false);
    fireEvent.click(button("Market buy PIRY-L"));
    await waitFor(() => expect(m.swap).toHaveBeenCalled());
  });

  it("applies to limit buys too", async () => {
    m.freshness = { state: "stale", ageSeconds: 2400 };
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText(/^Limit price/), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: "10" } });
    expect(button("Limit buy PIRY-L").disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await waitFor(() => expect(button("Limit buy PIRY-L").disabled).toBe(false));
  });

  it("shows no warning for a fresh or final mark", async () => {
    for (const state of ["fresh", "final"]) {
      cleanup();
      m.freshness = { state, ageSeconds: 10 };
      render(ui());
      await enterAmount("100");
      expect(screen.queryByText(/may not be able to withdraw/i)).toBeNull();
      expect(button("Market buy PIRY-L").disabled).toBe(false);
    }
  });

  it("does not gate a sell, which needs no withdrawal", async () => {
    m.freshness = { state: "stale", ageSeconds: 2400 };
    m.quote = { amountInUsed: 30_000_000n, amountOut: 15_000_000n };
    render(ui(false));
    await enterAmount("100", /^Sell/);
    expect(screen.queryByText(/may not be able to withdraw/i)).toBeNull();
    expect(button("Market sell PIRY-L").disabled).toBe(false);
  });
});
