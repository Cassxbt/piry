import type { Address } from "viem";
import { readHoldings, type Holdings, type Reader } from "./chain.js";
import type { Config } from "./config.js";
import { balanceOf, readAccount, type KuruAccount } from "./kuru.js";
import { fmt, netLong } from "./math.js";

export interface Place {
  wallet: bigint;
  kuruFree: bigint;
  kuruReserved: bigint;
}

// Where every unit of USDC, PIRY-L and PIRY-S is right now.
export interface Balances {
  rootId: bigint;
  usdc: Place;
  long: Place;
  short: Place;
}

export interface Leftover {
  token: "USDC" | "PIRY-L" | "PIRY-S";
  where: string;
  amount: string;
}

const KURU_FREE = "Kuru trading balance";
const KURU_RESERVED = "Kuru, reserved by open orders";

export function balancesOf(config: Config, holdings: Holdings, account: KuruAccount): Balances {
  const { collateral, longClaim, shortClaim } = config.series;
  const place = (wallet: bigint, token: Address): Place => {
    const kuru = balanceOf(account, token);
    return { wallet, kuruFree: kuru.free, kuruReserved: kuru.reserved };
  };
  return { rootId: account.rootId, usdc: place(holdings.collateral, collateral), long: place(holdings.long, longClaim), short: place(holdings.short, shortClaim) };
}

export async function readBalances(client: Reader, config: Config, owner: Address): Promise<Balances> {
  const { collateral, longClaim, shortClaim } = config.series;
  const [holdings, account] = await Promise.all([readHoldings(client, config, owner), readAccount(client, config.accountCore, owner, [collateral, longClaim, shortClaim])]);
  return balancesOf(config, holdings, account);
}

// What `position` counts as held: the wallet plus the free Kuru balance. Claims reserved by open orders are reported as
// leftovers instead, so a status here and the one from `position` are the same number.
export const held = (p: Place): bigint => p.wallet + p.kuruFree;
export const owned = (p: Place): bigint => held(p) + p.kuruReserved;
export const netCoverage = (b: Balances): bigint => netLong(held(b.long), held(b.short));

export function leftovers(b: Balances, decimals: number): Leftover[] {
  const rows: [Leftover["token"], string, bigint][] = [
    ["USDC", KURU_FREE, b.usdc.kuruFree],
    ["USDC", KURU_RESERVED, b.usdc.kuruReserved],
    ["PIRY-L", KURU_FREE, b.long.kuruFree],
    ["PIRY-L", KURU_RESERVED, b.long.kuruReserved],
    ["PIRY-S", KURU_FREE, b.short.kuruFree],
    ["PIRY-S", KURU_RESERVED, b.short.kuruReserved],
    ["PIRY-S", "wallet", b.short.wallet],
  ];
  return rows.filter(([, , amount]) => amount > 0n).map(([token, where, amount]) => ({ token, where, amount: fmt(amount, decimals) }));
}

// Concrete next actions for whatever is left outside the wallet. The plugin has no command that withdraws USDC or
// PIRY-S from Kuru, so for those the exact AccountCore call is given instead of a promise it cannot keep.
export function recovery(b: Balances, config: Config, owner: Address, decimals: number): string[] {
  const { collateral, shortClaim } = config.series;
  const call = (token: Address, amount: bigint) => `withdraw(rootAccountId ${b.rootId}, token ${token}, amount ${amount} in raw units, recipient ${owner}) on Kuru AccountCore ${config.accountCore}`;
  const lines: string[] = [];
  if (b.usdc.kuruFree > 0n) {
    lines.push(`${fmt(b.usdc.kuruFree, decimals)} USDC is idle in your Kuru trading balance. The next \`mm piry hedge\` spends it before depositing more; to take it back now, call ${call(collateral, b.usdc.kuruFree)}.`);
  }
  if (b.short.kuruFree > 0n) {
    lines.push(`${fmt(b.short.kuruFree, decimals)} PIRY-S is held in your Kuru trading balance and offsets the same amount of PIRY-L. Withdraw it with ${call(shortClaim, b.short.kuruFree)}, then \`mm piry unwind --method merge\` pairs it with PIRY-L for USDC; or hold both and run \`mm piry redeem\` after settlement, which withdraws Kuru-held claims itself.`);
  }
  if (b.short.wallet > 0n) {
    lines.push(`${fmt(b.short.wallet, decimals)} PIRY-S is in your wallet and offsets the same amount of PIRY-L. \`mm piry unwind --method merge\` merges matching pairs back into USDC.`);
  }
  if (b.long.kuruFree > 0n) {
    lines.push(`${fmt(b.long.kuruFree, decimals)} PIRY-L is in your Kuru trading balance. It counts toward coverage; \`mm piry unwind\` can sell it and \`mm piry redeem\` withdraws it after settlement.`);
  }
  if (b.usdc.kuruReserved + b.long.kuruReserved + b.short.kuruReserved > 0n) {
    lines.push("Some balances are reserved by open Kuru orders. They are not counted toward coverage; cancel the orders in Kuru to free them.");
  }
  if (lines.length > 0) lines.unshift("Run `mm piry position` first to see where every balance is.");
  return lines;
}
