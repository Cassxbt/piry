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

// Kuru stores fees as parts per this denominator: takerPps 7000 is 0.07%.
export const KURU_FEE_DENOMINATOR = 10_000_000n;

export interface PremiumQuote {
  // Executable cost plus the illustrative remainder.
  premium: bigint;
  // Claims (base units) the visible asks can fill now, counted only over the lots actually walked.
  filled: bigint;
  // Cost of those claims at the asks, taker fee included.
  executableCost: bigint;
  fee: bigint;
  // Claims the book cannot fill now, and what they would cost at the feed mark. Nobody has offered them at that price.
  remainder: bigint;
  remainderCost: bigint;
  basis: "book" | "book+mark" | "mark" | "book-partial";
}

export interface BookInput {
  asks: readonly Level[];
  scale: MarketScale;
  takerFeePps: bigint;
}

export interface MarkInput {
  value: bigint;
  scale: bigint;
}

// Cost of the whole hedge, kept in two parts: what the visible asks can fill now, and an illustrative remainder priced at
// the feed mark so a thin book never makes the hedge look cheaper than it is. Without a mark the remainder is left out
// ("book-partial"). Coverage is counted over the walked lots only: a fractional claim below one lot is never "filled".
export function quoteHedge(claims: bigint, book: BookInput | null, mark: MarkInput | null, collateralDecimals: number): PremiumQuote {
  const atMark = (units: bigint) => (mark ? (units * mark.value + mark.scale - 1n) / mark.scale : 0n);
  if (!book || book.asks.length === 0) {
    const remainderCost = atMark(claims);
    return { premium: remainderCost, filled: 0n, executableCost: 0n, fee: 0n, remainder: claims, remainderCost, basis: "mark" };
  }
  const walk = walkAsks(book.asks, sizeFromBaseAtoms(claims, book.scale), book.scale);
  const cost = (walk.cost * pow10(collateralDecimals)) / pow10(book.scale.quoteDecimals);
  const fee = (cost * book.takerFeePps + KURU_FEE_DENOMINATOR - 1n) / KURU_FEE_DENOMINATOR;
  const filledRaw = baseAtoms(walk.filledSize, book.scale);
  const filled = filledRaw < claims ? filledRaw : claims;
  const remainder = claims - filled;
  const remainderCost = remainder > 0n ? atMark(remainder) : 0n;
  const executableCost = cost + fee;
  const basis = remainder === 0n ? "book" : mark ? "book+mark" : "book-partial";
  return { premium: executableCost + remainderCost, filled, executableCost, fee, remainder, remainderCost, basis };
}

// A small example hedge the book can fill in full: the preferred size if the visible asks hold that many claims,
// otherwise as many round hours as fit, then fewer GPUs. depth is in claim base units.
export function exampleSize(
  depth: bigint,
  shape: Pick<Exposure, "band" | "priceDecimals" | "collateralDecimals">,
  preferred = { gpus: 8n, hours: 720n },
): { gpus: bigint; hours: bigint } {
  const perGpuHour = claimsToHold({ gpus: 1n, hours: 1n, ...shape });
  if (depth <= 0n || perGpuHour <= 0n) return preferred;
  const fits = depth / perGpuHour;
  if (fits >= preferred.gpus * preferred.hours) return preferred;
  const hours = fits / preferred.gpus;
  if (hours >= 10n) return { gpus: preferred.gpus, hours: hours - (hours % 10n) };
  return { gpus: 1n, hours: fits > 0n ? fits : 1n };
}

// Net result, in collateral units and before fees, of minting `quantity` pairs (1 collateral unit per pair), selling one
// leg for `proceeds` and keeping the other to settlement at `price`.
export function mintAndSellNet({ quantity, sold, proceeds, price, band }: { quantity: bigint; sold: "long" | "short"; proceeds: bigint; price: bigint; band: Band }): bigint {
  const kept = payouts(quantity, price, band)[sold === "long" ? "short" : "long"];
  return proceeds + kept - quantity;
}

// Index at which a claim bought (or, for the counterparty, sold) at `cost` per claim breaks even, before fees. Whoever
// mints a pair and sells the long keeps the short, so they break even at the same index as the long's buyer.
export function breakEvenIndex(side: "long" | "short", cost: number, { lower, upper }: { lower: number; upper: number }): number {
  return side === "long" ? lower + cost * (upper - lower) : upper - cost * (upper - lower);
}

export interface OtherSideRow {
  // Per pair minted (1 collateral unit), before fees and gas.
  net: number;
  maxGain: number;
  maxLoss: number;
  breakEven: number;
  // Which side of the break-even index the position profits on.
  wins: "below" | "above";
}

// The minter's position: sell one leg at `bid` per claim, keep the other, and see where it breaks even.
export function otherSide(sold: "long" | "short", bid: number, band: Band, priceDecimals: number, collateralDecimals: number, scrub: number): OtherSideRow {
  const net = mintAndSellNet({
    quantity: pow10(collateralDecimals), sold, proceeds: BigInt(Math.round(bid * 10 ** collateralDecimals)),
    price: BigInt(Math.round(scrub * 10 ** priceDecimals)), band,
  });
  const range = { lower: Number(band.lower) / 10 ** priceDecimals, upper: Number(band.upper) / 10 ** priceDecimals };
  return { net: Number(net) / 10 ** collateralDecimals, maxGain: bid, maxLoss: 1 - bid, breakEven: breakEvenIndex(sold, bid, range), wins: sold === "long" ? "below" : "above" };
}
