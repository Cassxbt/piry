import { baseAtoms, sizeFromBaseAtoms, walkAsks, type Level, type MarketScale } from "./kuruMath";
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

// The owner or lender side: rental income is gpus * hours * price, and short claims (sized like the long hedge) pay
// as the index falls. unhedged is the income with no claims, hedged is income plus the short payout less the premium.
export function ownerOutcomeAt(e: Exposure, claims: bigint, premium: bigint, price: bigint): Outcome {
  const income = monthlyBill(e, price);
  const payout = payouts(claims, price, e.band).short;
  return { price, unhedged: income, payout, hedged: income + payout - premium };
}

// Income the short hedge holds between floor and cap, before premium: the cap, because every dollar the index falls is paid back.
export function lockedOwnerIncome(e: Exposure): bigint {
  return monthlyBill(e, e.band.upper);
}

export type HedgeSide = "renter" | "owner";

export const outcomeFor = (side: HedgeSide, e: Exposure, claims: bigint, premium: bigint, price: bigint): Outcome =>
  side === "owner" ? ownerOutcomeAt(e, claims, premium, price) : outcomeAt(e, claims, premium, price);

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

// The price window a scenario chart shows: wide enough to see the flat region and both slopes, and the live price.
export function chartDomain(lower: number, upper: number, today: number): [number, number] {
  const span = upper - lower;
  return [Math.max(0, Math.min(lower - span * 0.6, today * 0.75)), Math.max(upper + span * 1.1, today * 1.2)];
}

export interface PremiumQuote {
  premium: bigint;
  // Claims (base units) the visible asks fill; the rest is priced at the feed mark.
  filled: bigint;
  basis: "book" | "book+mark" | "mark" | "book-partial";
}

export interface BookInput {
  asks: readonly Level[];
  scale: MarketScale;
}

export interface MarkInput {
  value: bigint;
  scale: bigint;
}

// Cost of the whole hedge: walk the visible asks, then price whatever the book cannot fill at the feed mark so a thin
// book never makes the hedge look cheaper than it is. Without a mark an unfilled remainder is left out ("book-partial").
export function quoteHedge(claims: bigint, book: BookInput | null, mark: MarkInput | null, collateralDecimals: number): PremiumQuote {
  const atMark = (units: bigint) => (mark ? (units * mark.value + mark.scale - 1n) / mark.scale : 0n);
  if (!book || book.asks.length === 0) return { premium: atMark(claims), filled: 0n, basis: "mark" };
  const walk = walkAsks(book.asks, sizeFromBaseAtoms(claims, book.scale), book.scale);
  const cost = (walk.cost * pow10(collateralDecimals)) / pow10(book.scale.quoteDecimals);
  if (walk.complete) return { premium: cost, filled: claims, basis: "book" };
  const filledRaw = baseAtoms(walk.filledSize, book.scale);
  const filled = filledRaw < claims ? filledRaw : claims;
  if (!mark) return { premium: cost, filled, basis: "book-partial" };
  return { premium: cost + atMark(claims - filled), filled, basis: "book+mark" };
}
