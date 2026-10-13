import { getAddress, isAddress, type Address } from "viem";
import { PiryError } from "./errors.js";

export const CHAIN_ID = 10143;
export const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";

export interface Series {
  market: Address;
  collateral: Address;
  longClaim: Address;
  shortClaim: Address;
  markFeed: Address;
  shortFeed: Address;
}

export const SERIES: Series = {
  market: "0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538",
  collateral: "0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1",
  longClaim: "0x7D4B1319648B1f2478495Dcce10313Cd045Ef997",
  shortClaim: "0xF3ACA854B4e0626CDedd391eC1396DBde6820d48",
  markFeed: "0xE4B79233F8ac4804BABfD6bd065aA6596b0EbE5e",
  shortFeed: getAddress("0xd97bd777304bbf14d713c5498951da52d50e2f80"),
};

export const KURU_ACCOUNT_CORE: Address = "0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038";

export const DEFAULT_KURU_MARKET: Address = getAddress("0xe2393d5f15523931e59f340cffebcde30fa7db1a");
export const DEFAULT_KURU_SHORT_MARKET: Address = getAddress("0xd93db02c88d645e669a3965cd46e72cca137f193");

export interface Config {
  rpcUrl: string;
  series: Series;
  accountCore: Address;
  kuruMarket: Address | null;
  kuruShortMarket: Address | null;
}

export interface ConfigInput {
  rpcUrl?: string;
  kuruMarket?: string;
  kuruShortMarket?: string;
  env?: Record<string, string | undefined>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkRpcUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PiryError("INVALID_CONFIG", `RPC URL is not a valid URL: ${raw}`, "Set PIRY_RPC_URL to an https:// endpoint for Monad testnet.");
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure) throw new PiryError("INVALID_CONFIG", `RPC URL must use https: ${raw}`, "Use an https:// endpoint, or a loopback http:// endpoint for a local fork.");
  return url.toString();
}

function checkKuruMarket(raw: string, label: string): Address {
  if (!isAddress(raw)) {
    throw new PiryError("INVALID_CONFIG", `Kuru ${label} market is not a valid address: ${raw}`, "Set the 0x order book address Kuru created for that pair (PIRY_KURU_MARKET / PIRY_KURU_SHORT_MARKET).");
  }
  const market = getAddress(raw);
  const known = [...Object.values(SERIES), KURU_ACCOUNT_CORE].map((a) => a.toLowerCase());
  if (/^0x0{40}$/i.test(raw) || known.includes(market.toLowerCase())) {
    throw new PiryError("INVALID_CONFIG", `Kuru ${label} market cannot be ${market}: it is a Piry or Kuru account contract, not an order book.`, "Use the order book address Kuru created for that pair.");
  }
  return market;
}

const blank = (value: string | undefined): string | undefined => (value && value.trim() !== "" ? value.trim() : undefined);

// A flag or env var overrides the default; an explicitly blank one disables the market.
function pickMarket(flag: string | undefined, envValue: string | undefined, fallback: Address): string | undefined {
  const raw = flag ?? envValue;
  return raw === undefined ? fallback : blank(raw);
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const env = input.env ?? {};
  const rpc = blank(input.rpcUrl) ?? blank(env.PIRY_RPC_URL) ?? DEFAULT_RPC_URL;
  const market = pickMarket(input.kuruMarket, env.PIRY_KURU_MARKET, DEFAULT_KURU_MARKET);
  const shortMarket = pickMarket(input.kuruShortMarket, env.PIRY_KURU_SHORT_MARKET, DEFAULT_KURU_SHORT_MARKET);
  return {
    rpcUrl: checkRpcUrl(rpc),
    series: SERIES,
    accountCore: KURU_ACCOUNT_CORE,
    kuruMarket: market === undefined ? null : checkKuruMarket(market, "PIRY-L"),
    kuruShortMarket: shortMarket === undefined ? null : checkKuruMarket(shortMarket, "PIRY-S"),
  };
}
