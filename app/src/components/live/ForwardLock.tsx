import { lockedMonthlyBill, lockedOwnerIncome, monthlyBill, outcomeFor, type Exposure, type HedgeSide } from "../../lib/hedge";
import { usdRounded } from "../../lib/format";
import { raw, trimmed } from "../../lib/numbers";

interface Props {
  exposure: Exposure;
  claims: bigint;
  premium: bigint;
  today: number;
  side?: HedgeSide;
}

// Where the hedge holds the bill or income inside the band, and how far that is from today's figure. The two are equal
// only when the premium happens to equal the claims' current intrinsic value, so the gap is shown, not assumed away.
export function ForwardLock({ exposure, claims, premium, today, side = "renter" }: Props) {
  const cd = exposure.collateralDecimals;
  const pd = exposure.priceDecimals;
  const L = raw(exposure.band.lower, pd);
  const U = raw(exposure.band.upper, pd);
  const money = (v: bigint) => usdRounded(v, cd);
  if (today >= U || today < L) return null;
  const todayAmount = monthlyBill(exposure, BigInt(Math.round(today * 10 ** pd)));
  const gap = (held: bigint) => (held === todayAmount ? "level with today\u2019s" : `${money(held > todayAmount ? held - todayAmount : todayAmount - held)} ${held > todayAmount ? "above" : "below"} today\u2019s`);
  if (side === "owner") {
    const stepped = Math.round((today - (today - L) * 0.75) * 10) / 10;
    const fall = stepped < today && stepped >= L ? stepped : L;
    const o = outcomeFor(side, exposure, claims, premium, BigInt(Math.round(fall * 10 ** pd)));
    const held = lockedOwnerIncome(exposure) - premium;
    return (
      <p className="callout forward-lock">
        <strong>What the hedge holds the income at.</strong> Inside the band the short claims hold your modelled income at the cap times your GPU-hours, less the premium: <strong className="num">{money(held)}</strong>. Today&rsquo;s income at the current index is <span className="num">{money(todayAmount)}</span>, so the hedge holds the income {gap(held)} income. If the index falls to <span className="num">${trimmed(fall, 2, 2)}</span>, unhedged income drops to <span className="num">{money(o.unhedged)}</span>; the hedged income stays at <strong className="num">{money(o.hedged)}</strong>. Protection stops at the floor, ${trimmed(L, 2, 2)}.
      </p>
    );
  }
  const stepped = Math.round((today + (U - today) * 0.75) * 10) / 10;
  const rise = stepped > today && stepped <= U ? stepped : U;
  const o = outcomeFor(side, exposure, claims, premium, BigInt(Math.round(rise * 10 ** pd)));
  const held = lockedMonthlyBill(exposure) + premium;
  return (
    <p className="callout forward-lock">
      <strong>What the hedge holds the bill at.</strong> Inside the band the long claims hold your modelled bill at your GPU-hours at the floor, plus the premium: <strong className="num">{money(held)}</strong>. Today&rsquo;s bill at the current index is <span className="num">{money(todayAmount)}</span>, so the hedge holds the bill {gap(held)} bill. If the index rises to <span className="num">${trimmed(rise, 2, 2)}</span>, an unhedged bill grows to <span className="num">{money(o.unhedged)}</span>; the hedged bill stays at <strong className="num">{money(o.hedged)}</strong>.
    </p>
  );
}
