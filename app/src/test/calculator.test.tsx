import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { config } from "../config";

const claim = "0x7D4B1319648B1f2478495Dcce10313Cd045Ef997" as Address;
const state = vi.hoisted(() => ({ base: "" as string }));

const snapshot = {
  address: "0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538",
  block: { number: 5n, timestamp: 1000n },
  terms: { lower: 2_500_000n, upper: 4_500_000n, priceDecimals: 6, periodEnd: 2000n },
  state: { settled: false },
  claims: { long: claim, short: "0xF3ACA854B4e0626CDedd391eC1396DBde6820d48", decimals: 6, longSymbol: "PIRY-L", shortSymbol: "PIRY-S" },
  collateral: { decimals: 6, symbol: "USDC" },
};
const mark = { status: "ok", indexPrice: 3_400_000n, answer: 45_000_000n, decimals: 8, roundId: 1n, block: 5n };
const book = () => ({
  market: "0x3333333333333333333333333333333333333333", block: 9n,
  scale: { pricePrecision: 1_000_000n, sizePrecision: 1n, tickSize: 100n, minQuote: 1_000_000n, maxQuote: 10n ** 12n, baseDecimals: 6, quoteDecimals: 6 },
  fees: { takerPps: 7000n, makerPps: 4000n }, baseToken: state.base || claim, quoteToken: config.kuru.quoteToken, state: 0,
  asks: [{ priceRaw: 500_000n, sizeRaw: 100n }], bids: [{ priceRaw: 440_000n, sizeRaw: 50n }],
});

vi.mock("../hooks/chain", () => ({
  useMarket: () => ({ data: snapshot }),
  useMark: () => ({ data: mark }),
  useSeriesShortMark: () => ({ data: { ...mark, answer: 55_000_000n } }),
}));
vi.mock("../hooks/kuru", () => ({ useKuruBook: () => ({ data: book(), isError: false }) }));
vi.mock("../components/charts/lazy", () => ({ ScenarioChart: () => null }));

const { Calculator } = await import("../sections/Calculator");

afterEach(() => {
  cleanup();
  state.base = "";
});

describe("Calculator", () => {
  it("opens on an example the visible book fills in full, with the fee and no illustrative remainder", async () => {
    render(<Calculator />);
    await waitFor(() => expect((screen.getByLabelText(/GPUs rented/) as HTMLInputElement).value).toBe("1"));
    expect((screen.getByLabelText(/Hours per month/) as HTMLInputElement).value).toBe("50");
    expect(screen.getByText("Executable now from the Kuru book")).toBeTruthy();
    expect(screen.getByText(/100(\.00)? claims at an average ask of \$0\.5000, plus the 0\.07% taker fee/)).toBeTruthy();
    expect(screen.getByText(/fill all 100 claims now/)).toBeTruthy();
    expect(screen.queryByText(/Illustrative remainder/)).toBeNull();
  });

  it("separates the executable part from the remainder priced at the mark when the size exceeds the book", async () => {
    render(<Calculator />);
    await waitFor(() => expect((screen.getByLabelText(/Hours per month/) as HTMLInputElement).value).toBe("50"));
    fireEvent.change(screen.getByLabelText(/Hours per month/), { target: { value: "100" } });
    await waitFor(() => expect(screen.getByText(/Illustrative remainder:/)).toBeTruthy());
    expect(screen.getByText(/can fill 100 of 200 claims now/)).toBeTruthy();
    expect(screen.getByText(/not a quote/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Size from the book" })).toBeTruthy();
  });

  it("does not price against a book whose base token is another series' claim", async () => {
    state.base = "0x9999999999999999999999999999999999999999";
    render(<Calculator />);
    await waitFor(() => expect(screen.getByText(/is not this series' market/)).toBeTruthy());
    expect(screen.queryByText(/plus the 0\.07% taker fee/)).toBeNull();
  });

  it("shows each minting strategy's own net result and break-even instead of one profit line", async () => {
    render(<Calculator />);
    expect(await screen.findByText("Taking the other side: mint a pair, sell one leg")).toBeTruthy();
    expect(screen.getByText(/not on whether it stays under the cap/)).toBeTruthy();
    expect(screen.getByText(/Sell PIRY-L, keep PIRY-S/)).toBeTruthy();
    expect(screen.getAllByText(/at or below \$3\./).length).toBeGreaterThan(0);
  });

  it("shows cost cards to the cent, rounded", async () => {
    render(<Calculator />);
    await waitFor(() => expect((screen.getByLabelText(/Hours per month/) as HTMLInputElement).value).toBe("50"));
    fireEvent.change(screen.getByLabelText(/GPUs rented/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Hours per month/), { target: { value: "1" } });
    await waitFor(() => expect(screen.getAllByText("$3.50").length).toBeGreaterThan(0));
  });

  it("names the invalid input instead of claiming the Kuru listing is pending", async () => {
    render(<Calculator />);
    await waitFor(() => expect((screen.getByLabelText(/Hours per month/) as HTMLInputElement).value).toBe("50"));
    fireEvent.change(screen.getByLabelText(/GPUs rented/), { target: { value: "abc" } });
    await waitFor(() => expect(screen.getAllByText(/Enter a whole number from 1 to 100,000/).length).toBeGreaterThan(1));
    expect(screen.queryByText(/Kuru listing pending/)).toBeNull();
  });

  it.each([["0", /above zero/], ["5000", /no more than/], ["-1", /such as 3\.00/]])("rejects the price %s with a message", async (value, message) => {
    render(<Calculator />);
    await waitFor(() => expect((screen.getByLabelText(/Hours per month/) as HTMLInputElement).value).toBe("50"));
    fireEvent.change(screen.getByLabelText(/Current price/), { target: { value } });
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(1));
    expect(screen.queryByText(/Kuru listing pending/)).toBeNull();
  });
});
