import { formatUnits } from "viem";
import { PiryError } from "./errors.js";

export const GPU_HOURS_DECIMALS = 6;
export const BPS = 10_000n;
export const MAX_SLIPPAGE_BPS = 1_000;
const MARK_SCALE = 100_000_000n;

export interface Band {
  lower: bigint;
  upper: bigint;
  priceDecimals: number;
}

const pow10 = (n: number) => 10n ** BigInt(n);

export function parseDecimal(text: string, decimals: number, label: string): bigint {
  const trimmed = text.trim();
  if (!/^\d{1,30}(\.\d{1,30})?$/.test(trimmed)) {
    throw new PiryError("INVALID_AMOUNT", `${label} must be a plain non-negative decimal such as 12.5, got "${text}".`, "Use digits and an optional decimal point; no signs, commas or exponents.");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new PiryError("INVALID_AMOUNT", `${label} has more than ${decimals} decimal places: "${text}".`, `Use at most ${decimals} decimal places.`);
  }
  return BigInt(whole) * pow10(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function parsePositive(text: string, decimals: number, label: string): bigint {
  const value = parseDecimal(text, decimals, label);
  if (value === 0n) throw new PiryError("INVALID_AMOUNT", `${label} must be greater than zero.`, "Pass a positive amount.");
  return value;
}

export function parseSlippageBps(text: string): number {
  if (!/^\d{1,5}$/.test(text.trim())) {
    throw new PiryError("INVALID_SLIPPAGE", `--slippage must be a whole number of basis points, got "${text}".`, "Example: --slippage 100 for 1%.");
  }
  const bps = Number(text);
  if (bps > MAX_SLIPPAGE_BPS) {
    throw new PiryError("INVALID_SLIPPAGE", `--slippage ${bps} bps exceeds the plugin maximum of ${MAX_SLIPPAGE_BPS} bps (10%).`, "Lower the slippage; a wider tolerance defeats the price protection.");
  }
  return bps;
}

export const fmt = (atoms: bigint, decimals: number): string => formatUnits(atoms, decimals);

// A long claim pays (clamp(P - L, 0, U - L)) / (U - L) collateral units, so holding hours * (U - L) claims
// offsets the bill increase between L and U exactly. Floored so the plugin never over-hedges.
export function claimsForGpuHours(gpuHoursMicro: bigint, band: Band, collateralDecimals: number): bigint {
  return (gpuHoursMicro * (band.upper - band.lower) * pow10(collateralDecimals)) / (pow10(GPU_HOURS_DECIMALS) * pow10(band.priceDecimals));
}

// Mirrors contracts/PayoutMath.sol: each leg is floored independently.
export function payouts(quantity: bigint, price: bigint, band: Band): { long: bigint; short: bigint } {
  if (band.lower >= band.upper) throw new RangeError("invalid bounds");
  if (price <= band.lower) return { long: 0n, short: quantity };
  if (price >= band.upper) return { long: quantity, short: 0n };
  const width = band.upper - band.lower;
  return { long: (quantity * (price - band.lower)) / width, short: (quantity * (band.upper - price)) / width };
}

// Mirrors ComputeMarket.previewRedeem: each leg is priced on its own amount.
export function previewRedeem(longAmount: bigint, shortAmount: bigint, price: bigint, band: Band): bigint {
  return payouts(longAmount, price, band).long + payouts(shortAmount, price, band).short;
}

export function slippageFloor(amount: bigint, bps: number): bigint {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

// The mark feed answer is the USD value of one whole claim with 8 decimals.
export function valueAtMark(claims: bigint, answer: bigint): bigint {
  return (claims * answer) / MARK_SCALE;
}

export function netLong(long: bigint, short: bigint): bigint {
  return long > short ? long - short : 0n;
}
