import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CONNECT_FIRST, resolveWallet, StaleOperationError, type WalletPort } from "../hooks/wallet";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x4444444444444444444444444444444444444444" as Address;
const CHAIN = 10143;

function port(over: Partial<WalletPort> & { address?: Address; chainId?: number } = {}) {
  const { address, chainId, ...rest } = over;
  const calls: string[] = [];
  const base: WalletPort = {
    account: () => ({ address: "address" in over ? address : A, chainId: "chainId" in over ? chainId : CHAIN }),
    switchChain: vi.fn(async () => void calls.push("switch")),
    walletClient: vi.fn(async (_id: number, account: Address) => (calls.push("client"), { account: { address: account, type: "json-rpc" } }) as never),
  };
  return { port: { ...base, ...rest }, calls };
}

describe("resolveWallet", () => {
  it("switches a wallet on another chain to the app chain before asking for the client", async () => {
    const { port: p, calls } = port({ chainId: 1 });
    const wallet = await resolveWallet(p, CHAIN, A, 0);
    expect(calls).toEqual(["switch", "client"]);
    expect(p.switchChain).toHaveBeenCalledWith(CHAIN);
    expect(wallet.account.address).toBe(A);
  });

  it("does not switch a wallet that is already on the app chain", async () => {
    const { port: p, calls } = port();
    await resolveWallet(p, CHAIN, A, 0);
    expect(calls).toEqual(["client"]);
  });

  it("waits out a wallet client that is not resolved yet instead of reporting no wallet", async () => {
    const walletClient = vi.fn<WalletPort["walletClient"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connector chain mismatch"))
      .mockResolvedValue({ account: { address: A, type: "json-rpc" } } as never);
    const { port: p } = port({ walletClient });
    const wallet = await resolveWallet(p, CHAIN, A, 0);
    expect(walletClient).toHaveBeenCalledTimes(3);
    expect(wallet.account.address).toBe(A);
  });

  it("surfaces the real error when the client never resolves", async () => {
    const walletClient = vi.fn<WalletPort["walletClient"]>().mockRejectedValue(new Error("provider unavailable"));
    const { port: p } = port({ walletClient });
    await expect(resolveWallet(p, CHAIN, A, 0)).rejects.toThrow("provider unavailable");
    expect(walletClient).toHaveBeenCalledTimes(3);
  });

  it("says to connect only when there is truly no account, and never tries to switch then", async () => {
    const { port: p } = port({ address: undefined, chainId: undefined });
    await expect(resolveWallet(p, CHAIN, undefined, 0)).rejects.toThrow(CONNECT_FIRST);
    expect(p.switchChain).not.toHaveBeenCalled();
    expect(p.walletClient).not.toHaveBeenCalled();
  });

  it("refuses when the connected account is no longer the one the operation started with", async () => {
    const { port: p } = port({ address: B, chainId: 1 });
    await expect(resolveWallet(p, CHAIN, A, 0)).rejects.toBeInstanceOf(StaleOperationError);
    expect(p.switchChain).not.toHaveBeenCalled();
  });

  it("does not ask for a client when the user rejects the network switch", async () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const { port: p } = port({ chainId: 1, switchChain: vi.fn(async () => Promise.reject(rejected)) });
    await expect(resolveWallet(p, CHAIN, A, 0)).rejects.toBe(rejected);
    expect(p.walletClient).not.toHaveBeenCalled();
  });
});
