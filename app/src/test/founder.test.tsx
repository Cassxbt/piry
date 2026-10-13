import { cleanup, render, screen } from "@testing-library/react";
import { isAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { FaucetCardView, MON_FAUCET_URL } from "../components/FaucetCard";
import { JudgeAccessView } from "../components/JudgeAccess";
import { PartnerNote } from "../components/PartnerNote";
import { config } from "../config";
import judgeAccess from "../config/judge-access.json";
import { links } from "../config/links";
import { faucetStatus } from "../lib/faucet";
import { parseJudgeWallets } from "../lib/judge";

afterEach(cleanup);

const faucetAddress = "0x6ee33fc6c23269463b7c824a34fea49acaa0c5d6";
const network = { name: "Monad Testnet", id: 10143, rpcUrl: "https://rpc", symbol: "MON" };
const idle = { phase: "idle" } as const;

describe("faucetStatus", () => {
  const base = { connected: true, claimed: false, faucetBalance: 1_000_000_000n, amount: 100_000_000n };
  it("walks through the states a judge can be in", () => {
    expect(faucetStatus({ ...base, connected: false })).toBe("no-wallet");
    expect(faucetStatus({ ...base, claimed: true })).toBe("claimed");
    expect(faucetStatus({ ...base, faucetBalance: 99_999_999n })).toBe("empty");
    expect(faucetStatus(base)).toBe("ready");
  });
  it("does not call the faucet empty while its balance is still loading", () => {
    expect(faucetStatus({ ...base, faucetBalance: undefined })).toBe("ready");
  });
});

describe("FaucetCardView", () => {
  it("shows the drip size, the faucet balance and the MON gas note with the official faucet link", () => {
    render(<FaucetCardView address={faucetAddress} amount={100_000_000n} faucetBalance={5_000_000_000n} status="ready" action={idle} button={<button>Drip</button>} />);
    expect(screen.getByText(/get 100 test usdc/i)).toBeTruthy();
    expect(screen.getByText(/5,000 USDC/)).toBeTruthy();
    expect(screen.getByText(/you need a little mon for gas/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /official monad testnet faucet/i }).getAttribute("href")).toBe(MON_FAUCET_URL);
  });
  it("says so when the wallet already claimed", () => {
    render(<FaucetCardView address={faucetAddress} amount={100_000_000n} faucetBalance={0n} status="claimed" action={idle} button={null} />);
    expect(screen.getByText(/already claimed/i)).toBeTruthy();
  });
});

describe("faucet and judge config", () => {
  it("points at the PiryFaucet on Monad testnet", () => {
    expect(config.faucet?.toLowerCase()).toBe(faucetAddress);
  });
  it("lists three valid public judge wallets", () => {
    expect(parseJudgeWallets(judgeAccess)).toHaveLength(3);
    for (const w of judgeAccess) expect(isAddress(w.address)).toBe(true);
  });
  it("shows live MON and USDC balances beside each judge wallet", () => {
    const wallets = parseJudgeWallets(judgeAccess);
    const balances = Object.fromEntries(wallets.map((w) => [w.address, { mon: 500_000_000_000_000_000n, usdc: 500_000_000n }]));
    render(<JudgeAccessView wallets={wallets} network={network} balances={balances} faucet={<p>faucet slot</p>} />);
    expect(screen.getAllByText(/0\.500 MON · 500\.00 USDC/)).toHaveLength(3);
    expect(screen.getByText("faucet slot")).toBeTruthy();
  });
});

describe("PartnerNote and founder links", () => {
  it("renders nothing without a quote and the quote with its source when set", () => {
    const { container } = render(<PartnerNote quote={null} />);
    expect(container.innerHTML).toBe("");
    render(<PartnerNote quote={{ text: "A useful hedge.", source: "A partner" }} />);
    expect(screen.getByText("A useful hedge.")).toBeTruthy();
    expect(screen.getByText("A partner")).toBeTruthy();
  });
  it("ships no partner quote until one is agreed, and the founder handles", () => {
    expect(links.partnerQuote).toBeNull();
    expect(links.x).toBe("https://x.com/cassxbt");
    expect(links.github).toBe("https://github.com/Cassxbt");
  });
});
