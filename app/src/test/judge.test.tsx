import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JudgeAccessView } from "../components/JudgeAccess";
import judgeAccess from "../config/judge-access.json";
import { parseJudgeWallets } from "../lib/judge";

afterEach(cleanup);

const address = "0x66d71a8612Fbf6ab69340Bf82aB431e1Ad30b5c3";
const network = { name: "Monad Testnet", id: 10143, rpcUrl: "https://rpc", symbol: "MON" };

describe("parseJudgeWallets", () => {
  it("keeps well-formed public wallets, drops malformed ones, and never carries a private key through", () => {
    const wallets = parseJudgeWallets([
      { label: "Judge 1", address, privateKey: "0x" + "ab".repeat(32) },
      { label: "bad address", address: "0x123" },
      { address },
      null,
    ]);
    expect(wallets).toEqual([{ label: "Judge 1", address }]);
  });

  it("returns an empty list for anything that is not an array", () => {
    expect(parseJudgeWallets({})).toEqual([]);
    expect(parseJudgeWallets(undefined)).toEqual([]);
  });
});

describe("judge-access.json", () => {
  it("holds public fields only, so no private key can ship in the bundle", () => {
    for (const entry of judgeAccess as Record<string, unknown>[]) expect(Object.keys(entry).sort()).toEqual(["address", "label"]);
  });
});

describe("JudgeAccessView", () => {
  it("points to the submission form when no wallets are configured", () => {
    render(<JudgeAccessView wallets={[]} network={network} />);
    expect(screen.getByText(/judge wallets are listed in the submission form/i)).toBeTruthy();
    expect(screen.getByText(/already fully redeemed/i)).toBeTruthy();
  });

  it("shows addresses and sends keys to the submission form, with a testnet-only warning and no reveal control", () => {
    render(<JudgeAccessView wallets={[{ label: "Judge 1", address }]} network={network} />);
    expect(screen.getByText(address)).toBeTruthy();
    expect(screen.getByText(/never put real funds here/i)).toBeTruthy();
    expect(screen.getByText(/private keys for these testnet-only wallets are in the submission form/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reveal/i })).toBeNull();
  });
});
