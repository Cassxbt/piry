export interface Band {
  lower: bigint;
  upper: bigint;
}

// Mirrors contracts/PayoutMath.sol: both legs round down, so long + short can fall one unit short of quantity.
export function payouts(quantity: bigint, price: bigint, { lower, upper }: Band): { long: bigint; short: bigint } {
  if (lower >= upper) throw new RangeError("invalid bounds");
  if (price <= lower) return { long: 0n, short: quantity };
  if (price >= upper) return { long: quantity, short: 0n };
  const width = upper - lower;
  return { long: (quantity * (price - lower)) / width, short: (quantity * (upper - price)) / width };
}

// Mirrors ComputeMarket.previewRedeem: each leg is priced on its own amount.
export function previewRedeem(longAmount: bigint, shortAmount: bigint, price: bigint, band: Band): bigint {
  return payouts(longAmount, price, band).long + payouts(shortAmount, price, band).short;
}

// Position of a price inside the band, clamped to [0, 1], for drawing.
export function bandPosition(price: bigint, { lower, upper }: Band): number {
  if (price <= lower) return 0;
  if (price >= upper) return 1;
  return Number(((price - lower) * 1_000_000n) / (upper - lower)) / 1_000_000;
}

// What flooring cost each leg, in base units (a fraction below one per leg). Mirrors the same clamp as payouts().
export function roundingLoss(longAmount: bigint, shortAmount: bigint, price: bigint, { lower, upper }: Band): { numerator: bigint; width: bigint } {
  const width = upper - lower;
  const clamp = (v: bigint) => (v < 0n ? 0n : v > width ? width : v);
  const above = clamp(price - lower);
  const below = clamp(upper - price);
  return { numerator: ((longAmount * above) % width) + ((shortAmount * below) % width), width };
}
