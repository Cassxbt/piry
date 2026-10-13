import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAction } from "../hooks/action";
import { CHANGED, CONNECT_FIRST, INPUTS_CHANGED } from "../hooks/wallet";
import { harness, HASH, OWNER_A, OWNER_B } from "./walletHarness";

vi.mock("wagmi", async () => (await import("./walletHarness")).wagmiMock);
vi.mock("wagmi/actions", async () => (await import("./walletHarness")).actionsMock);
vi.mock("../hooks/chain", async () => (await import("./walletHarness")).chainMock);

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
const mount = (identity: string, inputs = "") =>
  renderHook((p: { identity: string; inputs: string }) => useAction(p.identity, p.inputs), { wrapper, initialProps: { identity, inputs } });

beforeEach(() => harness.reset());
afterEach(cleanup);

describe("useAction", () => {
  it("reports Connect a wallet first only when there is no account, without touching the chain", async () => {
    harness.address = undefined;
    harness.chainId = undefined;
    const { result } = mount("x");
    await act(async () => void (await result.current.run("Drip", async (op) => (await op.wallet()).writeContract({} as never))));
    expect(result.current.state).toMatchObject({ phase: "error", message: CONNECT_FIRST });
    expect(harness.switchChain).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
  });

  it("rejects a second run while the first is still in flight, synchronously", async () => {
    const { result } = mount("x");
    let release: () => void = () => {};
    const send = vi.fn(() => new Promise<typeof HASH>((resolve) => (release = () => resolve(HASH))));
    let first: Promise<unknown> = Promise.resolve();
    let second: unknown = "unset";
    await act(async () => {
      first = result.current.run("One", send);
      second = await result.current.run("Two", send);
    });
    expect(second).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
    await act(async () => void (await result.current.run("Three", async () => HASH)));
    expect(result.current.state).toMatchObject({ phase: "done", label: "Three" });
  });

  it("aborts before the next write when the account switches mid-operation, even before a re-render", async () => {
    const { result } = mount("x");
    const write = vi.fn();
    await act(async () => {
      await result.current.run("Mint", async (op) => {
        await op.wallet();
        harness.address = OWNER_B;
        op.guard();
        write();
        return HASH;
      });
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: "error", message: CHANGED });
  });

  it("aborts when the series identity changes and shows nothing for the new identity", async () => {
    const { result, rerender } = mount("wallet A|series 1");
    const write = vi.fn();
    let release: () => void = () => {};
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.run("Mint", async (op) => {
        await new Promise<void>((resolve) => (release = resolve));
        op.guard();
        write();
        return HASH;
      });
    });
    expect(result.current.state.phase).toBe("wallet");
    rerender({ identity: "wallet A|series 2", inputs: "" });
    expect(result.current.state.phase).toBe("idle");
    await act(async () => {
      release();
      await pending;
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("idle");
    rerender({ identity: "wallet A|series 1", inputs: "" });
    expect(result.current.state).toMatchObject({ phase: "error", message: CHANGED });
  });

  it("aborts when the typed inputs change, with its own message", async () => {
    const { result, rerender } = mount("x", "100");
    let release: () => void = () => {};
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.run("Deposit", async (op) => {
        await new Promise<void>((resolve) => (release = resolve));
        op.guard();
        return HASH;
      });
    });
    rerender({ identity: "x", inputs: "250" });
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.state).toMatchObject({ phase: "error", message: INPUTS_CHANGED });
  });

  it("shows a finished result only while its identity is on screen", async () => {
    const { result, rerender } = mount("A");
    await act(async () => void (await result.current.run("Drip", async () => HASH)));
    expect(result.current.state).toMatchObject({ phase: "done", hash: HASH });
    rerender({ identity: "B", inputs: "" });
    expect(result.current.state.phase).toBe("idle");
    rerender({ identity: "A", inputs: "" });
    expect(result.current.state.phase).toBe("done");
  });

  it("keeps the submitted hash when confirmation fails", async () => {
    harness.client.waitForTransactionReceipt.mockRejectedValueOnce(new Error("rpc dropped"));
    const { result } = mount("x");
    await act(async () => void (await result.current.run("Mint", async () => HASH)));
    expect(result.current.state).toMatchObject({ phase: "error", hash: HASH, message: "rpc dropped" });
  });

  it("uses the account the operation started with when writing", async () => {
    const { result } = mount("x");
    await act(async () => void (await result.current.run("Mint", async (op) => (await op.wallet()).writeContract({} as never))));
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(harness.walletClient).toHaveBeenCalledWith(10143, OWNER_A);
  });
});
