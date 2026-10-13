import { lockedMonthlyBill, lockedOwnerIncome, outcomeFor, type Exposure, type HedgeSide } from "../../lib/hedge";
import { usd } from "../../lib/format";
import { raw, trimmed } from "../../lib/numbers";

interface Props {
  exposure: Exposure;
  claims: bigint;
  premium: bigint;
  today: number;
  side?: HedgeSide;
}

// Skimmers read "net = unhedged" at today's price as "the hedge does nothing". The point is the forward lock.
export function ForwardLock({ exposure, claims, premium, today, side = "renter" }: Props) {
  const cd = exposure.collateralDecimals;
  const pd = exposure.priceDecimals;
  const L = raw(exposure.band.lower, pd);
  const U = raw(exposure.band.upper, pd);
  const money = (v: bigint) => usd(v, cd, 0);
  if (today >= U || today < L) return null;
  if (side === "owner") {
    const stepped = Math.round((today - (today - L) * 0.75) * 10) / 10;
    const fall = stepped < today && stepped >= L ? stepped : L;
    const o = outcomeFor(side, exposure, claims, premium, BigInt(Math.round(fall * 10 ** pd)));
    return (
      <p className="callout forward-lock">
        <strong>Why the hedged income equals today&rsquo;s income.</strong> Inside the band the hedge locks your income at today&rsquo;s forward price, the cap less the premium: <strong className="num">{money(lockedOwnerIncome(exposure) - premium)}</strong>. It stays flat whichever way the index moves. If the index falls to <span className="num">${trimmed(fall, 2, 2)}</span>, unhedged income drops to <span className="num">{money(o.unhedged)}</span>; the hedged income stays at <strong className="num">{money(o.hedged)}</strong>. Protection stops at the floor, ${trimmed(L, 2, 2)}.
      </p>
    );
  }
  const stepped = Math.round((today + (U - today) * 0.75) * 10) / 10;
  const rise = stepped > today && stepped <= U ? stepped : U;
  const o = outcomeFor(side, exposure, claims, premium, BigInt(Math.round(rise * 10 ** pd)));
  return (
    <p className="callout forward-lock">
      <strong>Why the hedged bill equals today&rsquo;s bill.</strong> Inside the band the hedge locks your bill at today&rsquo;s forward price, the premium plus the floor: <strong className="num">{money(lockedMonthlyBill(exposure) + premium)}</strong>. It stays flat whichever way the index moves. If the index rises to <span className="num">${trimmed(rise, 2, 2)}</span>, an unhedged bill grows to <span className="num">{money(o.unhedged)}</span>; the hedged bill stays at <strong className="num">{money(o.hedged)}</strong>.
    </p>
  );
}
