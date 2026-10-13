import { describe, expect, it, vi } from "vitest";
import { depositToKuru, marketIssues, withdrawFromKuru, type KuruBook } from "../lib/kuru";

const claim = "0x1111111111111111111111111111111111111111" as const;
const usdc = "0x2222222222222222222222222222222222222222" as const;
const book = (over: Partial<KuruBook>): KuruBook => ({
  market: "0x3333333333333333333333333333333333333333",
  block: 1n,
  scale: { pricePrecision: 1_000_000n, sizePrecision: 1_000_000n, tickSize: 1n, minQuote: 1n, maxQuote: 2n, baseDecimals: 6, quoteDecimals: 6 },
  fees: { takerPps: 0n, makerPps: 0n },
  baseToken: claim,
  quoteToken: usdc,
  state: 0,
  bids: [],
  asks: [],
  ...over,
});

describe("marketIssues", () => {
  it("accepts a market whose own base and quote tokens match", () => {
    expect(marketIssues(book({}), { base: claim, quote: usdc })).toEqual([]);
  });

  it("compares addresses case-insensitively", () => {
    expect(marketIssues(book({ baseToken: claim.toUpperCase().replace("0X", "0x") as `0x${string}` }), { base: claim, quote: usdc })).toEqual([]);
  });

  it("flags a different base token, a different quote token and an inactive market", () => {
    const issues = marketIssues(
      book({ baseToken: "0x4444444444444444444444444444444444444444", quoteToken: "0x5555555555555555555555555555555555555555", state: 2 }),
      { base: claim, quote: usdc },
    );
    expect(issues).toHaveLength(3);
  });
});

describe("depositToKuru and withdrawFromKuru guards", () => {
  const hash = `0x${"11".repeat(32)}` as const;
  const session = (allowance: bigint) => {
    const calls: string[] = [];
    const s = {
      pc: {
        readContract: vi.fn(async () => allowance),
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
      },
      owner: "0x1111111111111111111111111111111111111111",
      accountCore: "0x2222222222222222222222222222222222222222",
      account: {
        approveErc20: vi.fn(async () => (calls.push("approve"), hash)),
        depositToOwner: vi.fn(async () => (calls.push("deposit"), hash)),
        getRootAccountId: vi.fn(async () => 7n),
        withdraw: vi.fn(async () => (calls.push("withdraw"), hash)),
      },
      spot: {},
    };
    return { s: s as never, raw: s, calls };
  };
  const token = "0x3333333333333333333333333333333333333333" as const;

  it("does not deposit when the guard trips after the approval confirmed", async () => {
    const { s, raw, calls } = session(0n);
    let n = 0;
    const guard = () => {
      if (++n === 2) throw new Error("Wallet or series changed; nothing further was sent");
    };
    await expect(depositToKuru(s, token, 5n, guard)).rejects.toThrow(/nothing further was sent/);
    expect(calls).toEqual(["approve"]);
    expect(raw.account.depositToOwner).not.toHaveBeenCalled();
  });

  it("approves then deposits when nothing changed, and skips the approval when the allowance covers it", async () => {
    const first = session(0n);
    await depositToKuru(first.s, token, 5n, () => {});
    expect(first.calls).toEqual(["approve", "deposit"]);
    const second = session(10n);
    await depositToKuru(second.s, token, 5n, () => {});
    expect(second.calls).toEqual(["deposit"]);
  });

  it("does not withdraw when the guard trips", async () => {
    const { s, raw } = session(0n);
    await expect(withdrawFromKuru(s, token, 5n, () => { throw new Error("changed"); })).rejects.toThrow("changed");
    expect(raw.account.withdraw).not.toHaveBeenCalled();
  });
});
