import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionButton } from "../components/Action";
import { FaucetCard } from "../components/FaucetCard";
import { harness, OWNER_A, OWNER_B } from "./walletHarness";

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/viewer", async () => (await import("./walletHarness")).viewerMock);
vi.mock("../hooks/chain", async () => (await import("./walletHarness")).chainMock);
vi.mock("../hooks/faucet", () => ({ useFaucet: () => ({ data: { claimed: false, balance: 5_000_000_000n, amount: 100_000_000n } }) }));

const DRIP = "Get 100 test USDC";
const view = () => (
  <QueryClientProvider client={new QueryClient()}>
    <FaucetCard />
  </QueryClientProvider>
);

beforeEach(() => harness.reset());
afterEach(cleanup);

describe("faucet drip with the wallet client unresolved", () => {
  it("switches a wallet on another chain, then sends the drip instead of saying Connect a wallet first", async () => {
    harness.chainId = 10143;
    render(view());
    harness.chainId = 1;
    fireEvent.click(screen.getByRole("button", { name: DRIP }));
    await waitFor(() => expect(harness.write).toHaveBeenCalledTimes(1));
    expect(harness.switchChain).toHaveBeenCalledWith(10143);
    expect(screen.queryByText(/Connect a wallet first/)).toBeNull();
    await waitFor(() => expect(screen.getByText(/Drip confirmed/)).toBeTruthy());
  });

  it("sends the drip from the connected account", async () => {
    render(view());
    fireEvent.click(screen.getByRole("button", { name: DRIP }));
    await waitFor(() => expect(harness.write).toHaveBeenCalled());
    expect(harness.client.simulateContract.mock.calls[0]?.[0]).toMatchObject({ account: { address: OWNER_A }, functionName: "drip" });
  });
});

describe("faucet sent state", () => {
  it("is keyed by wallet: a claim from A does not disable an unclaimed wallet B", async () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole("button", { name: DRIP }));
    await waitFor(() => expect(screen.getByText("This wallet has already claimed. Each address can drip once.")).toBeTruthy());
    expect((screen.getByRole("button", { name: DRIP }) as HTMLButtonElement).disabled).toBe(true);

    harness.address = OWNER_B;
    rerender(view());
    expect((screen.getByRole("button", { name: DRIP }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("This wallet has already claimed. Each address can drip once.")).toBeNull();
    expect(screen.queryByText(/Drip confirmed/)).toBeNull();
  });

  it("still remembers A when the user switches back", async () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole("button", { name: DRIP }));
    await waitFor(() => expect(screen.getByText(/already claimed/)).toBeTruthy());
    harness.address = OWNER_B;
    rerender(view());
    harness.address = OWNER_A;
    rerender(view());
    expect((screen.getByRole("button", { name: DRIP }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ActionButton", () => {
  it("offers the network switch on the wrong chain and runs nothing", () => {
    harness.chainId = 1;
    const run = vi.fn();
    render(<ActionButton label="Do it" busy={false} onRun={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to Monad Testnet" }));
    expect(harness.switchChain).toHaveBeenCalledWith(10143);
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
  });
});
