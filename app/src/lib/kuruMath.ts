import { formatUnits, parseUnits } from "viem";

export interface MarketScale {
  pricePrecision: bigint;
  sizePrecision: bigint;
  tickSize: bigint;
  minQuote: bigint;
  maxQuote: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}

export function precisionDecimals(precision: bigint): number {
  const text = precision.toString();
  if (!/^10*$/.test(text)) throw new Error(`Unsupported precision: ${precision}`);
  return text.length - 1;
}

// Kuru encodes prices and sizes as integers in pricePrecision / sizePrecision units.
export function toPriceRaw(text: string, scale: MarketScale): bigint | null {
  return toScaled(text, precisionDecimals(scale.pricePrecision));
}

export function toSizeRaw(text: string, scale: MarketScale): bigint | null {
  return toScaled(text, precisionDecimals(scale.sizePrecision));
}

function toScaled(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return null;
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  return parseUnits(trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed, decimals);
}

export const priceHuman = (raw: bigint, scale: MarketScale) => Number(raw) / Number(scale.pricePrecision);
export const sizeHuman = (raw: bigint, scale: MarketScale) => Number(raw) / Number(scale.sizePrecision);

// Quote-token atoms for an order: price * size, as in the Kuru quickstart.
export function quoteNotional(priceRaw: bigint, sizeRaw: bigint, scale: MarketScale): bigint {
  return (((priceRaw * sizeRaw) / scale.sizePrecision) * 10n ** BigInt(scale.quoteDecimals)) / scale.pricePrecision;
}

// Base-token atoms: sizeRaw * (10^baseDecimals / sizePrecision).
export function baseAtoms(sizeRaw: bigint, scale: MarketScale): bigint {
  return (sizeRaw * 10n ** BigInt(scale.baseDecimals)) / scale.sizePrecision;
}

export function sizeFromBaseAtoms(atoms: bigint, scale: MarketScale): bigint {
  return (atoms * scale.sizePrecision) / 10n ** BigInt(scale.baseDecimals);
}

export function checkLimitOrder(priceRaw: bigint | null, sizeRaw: bigint | null, scale: MarketScale): string | null {
  if (priceRaw === null || priceRaw <= 0n) return "Enter a limit price.";
  if (sizeRaw === null || sizeRaw <= 0n) return "Enter a quantity.";
  if (priceRaw > 0xffff_ffffn) return "Price is above the market's maximum.";
  if (priceRaw % scale.tickSize !== 0n) return `Price must be a multiple of the tick (${scale.tickSize} units).`;
  if (sizeRaw >= 1n << 96n) return "Quantity is too large.";
  const quote = quoteNotional(priceRaw, sizeRaw, scale);
  if (quote < scale.minQuote) return "Order is below the market's minimum notional.";
  if (quote > scale.maxQuote) return "Order is above the market's maximum notional.";
  return null;
}

export function slippageFloor(amountOut: bigint, bps: number): bigint {
  return (amountOut * BigInt(10_000 - bps)) / 10_000n;
}

export interface SwapPlan {
  amountIn: bigint;
  minAmountOut: bigint;
  partial: boolean;
}

// What to submit for a quote. When the book can absorb only part of the entered input, only that part is sent:
// the output floor is derived from the quote's own output, so it protects the price only for the input it priced.
export function planSwap(quote: { amountInUsed: bigint; amountOut: bigint }, requestedIn: bigint, bps: number): SwapPlan | null {
  if (quote.amountInUsed <= 0n || quote.amountOut <= 0n) return null;
  const minAmountOut = slippageFloor(quote.amountOut, bps);
  if (minAmountOut <= 0n) return null;
  const amountIn = quote.amountInUsed < requestedIn ? quote.amountInUsed : requestedIn;
  return { amountIn, minAmountOut, partial: amountIn < requestedIn };
}

export interface Level {
  priceRaw: bigint;
  sizeRaw: bigint;
}

export interface Walk {
  cost: bigint;
  filledSize: bigint;
  complete: boolean;
}

// Cost of buying `wantedSize` (size units) by walking asks from the best price up. Rounds each level up for the buyer.
export function walkAsks(asks: readonly Level[], wantedSize: bigint, scale: MarketScale): Walk {
  const denominator = scale.pricePrecision * scale.sizePrecision;
  let remaining = wantedSize;
  let cost = 0n;
  for (const level of asks) {
    if (remaining <= 0n) break;
    const take = remaining < level.sizeRaw ? remaining : level.sizeRaw;
    cost += (level.priceRaw * take * 10n ** BigInt(scale.quoteDecimals) + denominator - 1n) / denominator;
    remaining -= take;
  }
  return { cost, filledSize: wantedSize - remaining, complete: remaining <= 0n };
}

// Full price precision with trailing zeros trimmed, never fewer than four decimals, so distinct ticks stay distinct.
export function priceText(raw: bigint, scale: MarketScale): string {
  const decimals = precisionDecimals(scale.pricePrecision);
  const text = formatUnits(raw, decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(Math.min(4, decimals), "0");
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}
