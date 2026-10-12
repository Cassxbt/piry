import { payouts, type Band } from "./payout";

export interface Exposure {
  gpus: bigint;
  hours: bigint;
  band: Band;
  priceDecimals: number;
  collateralDecimals: number;
}

const pow10 = (n: number) => 10n ** BigInt(n);

// A long claim pays (clamp(P - L) / (U - L)) collateral units, so gpus * hours * (U - L) claims
// offset exactly gpus * hours * clamp(P - L) of bill increase. Everything is floored like PayoutMath.
export function claimsToHold({ gpus, hours, band, priceDecimals, collateralDecimals }: Exposure): bigint {
  const spread = (gpus * hours * (band.upper - band.lower) * pow10(collateralDecimals)) / pow10(priceDecimals);
  return spread < 0n ? 0n : spread;
}

// Claims are 1:1 with collateral units at the cap, so the maximum payout equals the claim quantity.
export function maxPayout(claims: bigint): bigint {
  return claims;
}

export function monthlyBill(e: Exposure, price: bigint): bigint {
  return (e.gpus * e.hours * price * pow10(e.collateralDecimals)) / pow10(e.priceDecimals);
}

// Buyer-side rounding: cost of claims at a limit/ask price expressed in quote units per whole claim (pricePrecision scaled).
export function premiumCost(
  claims: bigint,
  askRaw: bigint,
  pricePrecision: bigint,
  claimDecimals: number,
  quoteDecimals: number,
): bigint {
  const numerator = claims * askRaw * pow10(quoteDecimals);
  const denominator = pricePrecision * pow10(claimDecimals);
  return (numerator + denominator - 1n) / denominator;
}

export interface Outcome {
  price: bigint;
  unhedged: bigint;
  payout: bigint;
  hedged: bigint;
}

// hedged = bill - payout + premium, all in collateral base units.
export function outcomeAt(e: Exposure, claims: bigint, premium: bigint, price: bigint): Outcome {
  const unhedged = monthlyBill(e, price);
  const payout = payouts(claims, price, e.band).long;
  return { price, unhedged, payout, hedged: unhedged - payout + premium };
}

export type Regime = "below" | "in-band" | "above";

export function regimeOf(price: bigint, { lower, upper }: Band): Regime {
  if (price < lower) return "below";
  if (price > upper) return "above";
  return "in-band";
}

// Price the hedge locks in at inside the band, before premium: the floor L.
export function lockedMonthlyBill(e: Exposure): bigint {
  return monthlyBill(e, e.band.lower);
}
