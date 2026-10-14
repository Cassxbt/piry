import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import settings from "../config/monad-testnet.json";
import type { LogSource } from "../lib/logsClient";
import { decodeFills, scanTraction, summarizeTraction } from "../lib/traction";

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

  it("splits trades, fills, wallets and volume between team and unclassified", () => {
    const t = summarizeTraction(logs, [team], scales);
    expect(t.team).toMatchObject({ trades: 1, fills: 1, wallets: 1, volume: 1, minted: 1 });
    expect(t.unclassified).toMatchObject({ trades: 2, fills: 3, wallets: 1, volume: 3.2, minted: 1, redeemed: 1 });
  });

  it("matches team addresses case-insensitively and counts everyone else as unclassified", () => {
    const t = summarizeTraction(logs, [team.toLowerCase() as typeof team], scales);
    expect(t.team.trades).toBe(1);
    expect(summarizeTraction(logs, [], scales).team.trades).toBe(0);
  });
});

describe("summarizeTraction validity", () => {
  const scales = { [market]: scale };

  it("counts only positive fills: zero and empty records are not trades", () => {
    const logs = {
      trades: [
        { market, executor: team, fills: [{ price: 0n, size: 0n }] },
        { market, executor: team, fills: [] },
        { market, executor: team, fills: [{ price: 5000n, size: 0n }, { price: 5000n, size: 2_000_000n }] },
      ],
      pairs: [],
    };
    expect(summarizeTraction(logs, [team], scales).team).toMatchObject({ trades: 1, fills: 1, volume: 1, wallets: 1 });
  });

  it("does not report volume as zero when a market scale is missing", () => {
    const logs = { trades: [{ market, executor: team, fills: [{ price: 5000n, size: 2_000_000n }] }], pairs: [] };
    const t = summarizeTraction(logs, [team], {});
    expect(t.team).toMatchObject({ trades: 1, fills: 1, volume: 0, volumeComplete: false });
    expect(summarizeTraction(logs, [team], scales).team.volumeComplete).toBe(true);
  });
});

describe("configured team list", () => {
  const listed = new Set((settings.teamAddresses as string[]).map((a) => a.toLowerCase()));

  it.each([
    ["MetaMask Agent Wallet", "0x8a9b8d5c25F182fda610E5fe8c7276ECd69E9d3A"],
    ["judge wallet 1", "0xCf82e5491BE3DAE0a93e43b7085a23D96C58be9F"],
    ["judge wallet 2", "0x30627D981A566ABd5130561bbbd28BaD87f113FF"],
    ["judge wallet 3", "0xD4E1410661CC5EFb0df72Edc6df1365436C5058D"],
    ["founder test wallet", "0xCf330e9d8aabf8a923E38614e8156e19B2aDFEBB"],
    ["QA wallet 1", "0x02F0DB1D96C059Ce27444fe45aEDb12ae12B157c"],
    ["QA wallet 2", "0xf4E13c8738BDA7a90175a8EbD5262a4b93C46968"],
  ])("labels the %s as team", (_name, address) => {
    expect(listed.has(address.toLowerCase())).toBe(true);
    const logs = { trades: [{ market, executor: address as `0x${string}`, fills: [{ price: 5000n, size: 20n }] }], pairs: [] };
    expect(summarizeTraction(logs, settings.teamAddresses as `0x${string}`[], { [market]: scale }).team.trades).toBe(1);
  });

  it("scans from the market deployment block", () => {
    expect(settings.tractionFromBlock).toBe(70409792);
  });
});

describe("scanTraction", () => {
  const compute = "0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538" as const;
  const packedHex = `0x${record(5000n, 2_000_000n)}` as Hex;
  const trade = (block: bigint) => ({ address: market, eventName: "TradesPacked", blockNumber: block, args: { executor: other, packedTrades: packedHex } });
  const minted = (block: bigint) => ({ address: compute, eventName: "PairsMinted", blockNumber: block, args: { account: other } });
  type Query = { fromBlock: bigint; toBlock: bigint };
  const source = (getLogs: (q: Query) => Promise<unknown[]>) => ({ client: { getLogs }, maxRange: 100, name: "test" }) as unknown as LogSource;
  const args = { markets: [market], computeMarket: compute, fromBlock: 1n, toBlock: 400n, maxRequests: 10 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for trades and pair events in one request per block range", async () => {
    const calls: Query[] = [];
    const out = await scanTraction(
      source(async (q) => { calls.push(q); return q.fromBlock === 101n ? [trade(150n), minted(160n)] : []; }),
      args,
    );
    expect(calls).toHaveLength(4);
    expect(out.trades).toHaveLength(1);
    expect(out.pairs).toEqual([{ kind: "minted", account: other }]);
    expect(out.reachedBlock).toBe(1n);
  });

  it("reports progress only for the unbroken newest-first range that has finished", async () => {
    const release = new Map<bigint, () => void>();
    const progress: { reached: bigint; trades: number }[] = [];
    const run = scanTraction(
      source(async (q) => {
        await new Promise<void>((resolve) => release.set(q.fromBlock, resolve));
        return q.fromBlock === 201n || q.fromBlock === 301n ? [trade(q.fromBlock + 50n)] : [];
      }),
      args,
      (p) => progress.push({ reached: p.reachedBlock, trades: p.trades.length }),
    );
    await tick();
    release.get(201n)!();
    await tick();
    expect(progress).toEqual([]);
    release.get(301n)!();
    await tick();
    expect(progress).toEqual([{ reached: 201n, trades: 2 }]);
    release.get(1n)!();
    await tick();
    expect(progress).toHaveLength(1);
    release.get(101n)!();
    const out = await run;
    expect(progress.at(-1)).toEqual({ reached: 1n, trades: 2 });
    expect(out.reachedBlock).toBe(1n);
  });
});
