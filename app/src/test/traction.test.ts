import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { decodeFills, summarizeTraction } from "../lib/traction";

const team = "0x66d71a8612Fbf6ab69340Bf82aB431e1Ad30b5c3" as const;
const other = "0x1111111111111111111111111111111111111111" as const;
const market = "0xe2393d5f15523931e59f340cffebcde30fa7db1a" as const;
const scale = { pricePrecision: 10_000n, sizePrecision: 1_000_000n, tickSize: 1n, minQuote: 0n, maxQuote: 10n ** 30n, baseDecimals: 6, quoteDecimals: 6 };

// price 5000 (0.50), size 2,000,000 (2 claims) in the first word's documented bit positions.
const word = (price: bigint, size: bigint) => ((price << 168n) | (size << 72n)).toString(16).padStart(64, "0");
const record = (price: bigint, size: bigint) => word(price, size) + "0".repeat(64);

describe("decodeFills", () => {
  it("reads price and size from each 64-byte record", () => {
    const packed = `0x${record(5000n, 2_000_000n)}${record(6000n, 1_000_000n)}` as Hex;
    expect(decodeFills(packed)).toEqual([
      { price: 5000n, size: 2_000_000n },
      { price: 6000n, size: 1_000_000n },
    ]);
  });
});

describe("summarizeTraction", () => {
  const scales = { [market]: scale };
  const logs = {
    trades: [
      { market, executor: team, fills: [{ price: 5000n, size: 2_000_000n }] },
      { market, executor: other, fills: [{ price: 6000n, size: 1_000_000n }, { price: 6000n, size: 1_000_000n }] },
      { market, executor: other, fills: [{ price: 5000n, size: 4_000_000n }] },
    ],
    pairs: [
      { kind: "minted" as const, account: team },
      { kind: "minted" as const, account: other },
      { kind: "redeemed" as const, account: other },
    ],
  };

  it("splits trades, fills, wallets and volume between team and external", () => {
    const t = summarizeTraction(logs, [team], scales);
    expect(t.team).toMatchObject({ trades: 1, fills: 1, wallets: 1, volume: 1, minted: 1 });
    expect(t.external).toMatchObject({ trades: 2, fills: 3, wallets: 1, volume: 3.2, minted: 1, redeemed: 1 });
  });

  it("matches team addresses case-insensitively and counts everyone else as external", () => {
    const t = summarizeTraction(logs, [team.toLowerCase() as typeof team], scales);
    expect(t.team.trades).toBe(1);
    expect(summarizeTraction(logs, [], scales).team.trades).toBe(0);
  });
});
