import { useEffect, useMemo, useState } from "react";
import { Field } from "../components/Field";
import { HedgeChart, chartDomain } from "../components/HedgeChart";
import { Section } from "../components/Section";
import { Src } from "../components/Src";
import { config } from "../config";
import { useMark, useMarket } from "../hooks/chain";
import { useKuruBook } from "../hooks/kuru";
import { claimsToHold, lockedMonthlyBill, maxPayout, outcomeAt, regimeOf, type Exposure } from "../lib/hedge";
import { fixed, parseAmount, usd } from "../lib/format";
import { sizeFromBaseAtoms, walkAsks } from "../lib/kuruMath";
import { payouts } from "../lib/payout";

const ILLUSTRATIVE_DECIMALS = 6;

function integerOrNull(text: string, max: number): bigint | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = BigInt(text.trim());
  return n >= 1n && n <= BigInt(max) ? n : null;
}

export function Calculator() {
  const market = useMarket();
  const mark = useMark();
  const snapshot = market.data;
  const live = snapshot !== undefined;

  const pd = snapshot?.terms.priceDecimals ?? ILLUSTRATIVE_DECIMALS;
  const cd = snapshot?.collateral.decimals ?? ILLUSTRATIVE_DECIMALS;
  const claimDecimals = snapshot?.claims.decimals ?? cd;

  const [gpus, setGpus] = useState("64");
  const [hours, setHours] = useState("720");
  const [price, setPrice] = useState("3.00");
  const [illLower, setIllLower] = useState("2.00");
  const [illUpper, setIllUpper] = useState("4.00");
  const [manualPremium, setManualPremium] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [scrubOverride, setScrub] = useState<number | null>(null);

  const lower = live ? snapshot.terms.lower : parseAmount(illLower, pd);
  const upper = live ? snapshot.terms.upper : parseAmount(illUpper, pd);

  const indexPrice = mark.data?.status === "ok" ? mark.data.indexPrice : snapshot?.state.settled ? snapshot.state.settlementPrice : null;
  useEffect(() => {
    if (!priceTouched && indexPrice !== null && indexPrice > 0n) setPrice((Number(indexPrice) / 10 ** pd).toFixed(2));
  }, [indexPrice, pd, priceTouched]);

  const g = integerOrNull(gpus, 100_000);
  const h = integerOrNull(hours, 744);
  const p = parseAmount(price, pd);
  const bandOk = lower !== null && upper !== null && lower < upper;
  const inputsOk = g !== null && h !== null && p !== null && bandOk;

  const book = useKuruBook("long");

  const calc = useMemo(() => {
    if (!inputsOk || lower === null || upper === null) return null;
    const exposure: Exposure = { gpus: g, hours: h, band: { lower, upper }, priceDecimals: pd, collateralDecimals: cd };
    const claims = claimsToHold(exposure);
    return { exposure, claims };
  }, [inputsOk, g, h, lower, upper, pd, cd]);

  const quote = useMemo(() => {
    if (!calc) return null;
    const data = book.data;
    if (data && data.asks.length > 0) {
      const walk = walkAsks(data.asks, sizeFromBaseAtoms(calc.claims, data.scale), data.scale);
      const toCollateral = (quoteAtoms: bigint) => (quoteAtoms * 10n ** BigInt(cd)) / 10n ** BigInt(data.scale.quoteDecimals);
      const best = data.asks[0]!;
      return {
        kind: "kuru" as const,
        premium: toCollateral(walk.cost),
        complete: walk.complete,
        bestAsk: Number(best.priceRaw) / Number(data.scale.pricePrecision),
        bestSize: Number(best.sizeRaw) / Number(data.scale.sizePrecision),
        block: data.block,
      };
    }
    return null;
  }, [calc, book.data, cd]);

  const intrinsic = useMemo(() => (calc && p !== null ? payouts(calc.claims, p, calc.exposure.band).long : 0n), [calc, p]);

  const manual = parseAmount(manualPremium, 6);
  const claimsWhole = calc ? Number(calc.claims) / 10 ** claimDecimals : 0;
  const premium = quote ? quote.premium : manual !== null && calc ? (calc.claims * manual) / 10n ** 6n : intrinsic;
  const premiumBasis = quote ? "Kuru asks (live)" : manual !== null ? "your assumed price" : "intrinsic reference, not a quote";

  const L = lower !== null ? Number(lower) / 10 ** pd : 0;
  const U = upper !== null ? Number(upper) / 10 ** pd : 1;
  const today = p !== null ? Number(p) / 10 ** pd : (L + U) / 2;
  const domain = chartDomain(L, U, today);
  const scrub = scrubOverride ?? today;

  const money = (raw: bigint) => usd(raw, cd, 0);
  const row = (price: number) => {
    if (!calc) return null;
    return outcomeAt(calc.exposure, calc.claims, premium, BigInt(Math.round(price * 10 ** pd)));
  };
  const span = U - L;
  const scenarios = calc
    ? ([
        { key: "below", title: "Below the floor", price: Math.max(0.01, L - span * 0.5), note: "The long pays nothing. You keep the cheaper GPUs and lose the premium." },
        { key: "in-band", title: "Inside the band", price: (L + U) / 2, note: "Every extra dollar of GPU price is paid back by the claims, so the bill stays flat." },
        { key: "above", title: "Above the cap", price: U + span * 0.5, note: "The claims have paid their maximum. Each further dollar comes out of your pocket." },
      ] as const)
    : [];

  const scrubRow = row(scrub);
  const regime = lower !== null && upper !== null ? regimeOf(BigInt(Math.round(scrub * 10 ** pd)), { lower, upper }) : "in-band";

  return (
    <Section
      id="exposure"
      index="02"
      kicker="Exposure"
      title={
        <>
          Size the hedge, and see <em>exactly</em> where it stops
        </>
      }
      lede="Enter the GPUs you rent. The calculator sizes the long claims that offset the bill increase inside the band, prices them against the live Kuru book, and plots your monthly bill with and without them."
    >
      <div className="calc">
        <div className="panel">
          <div className="panel-head">
            <span className="label">Your exposure</span>
            {live ? <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} /> : <span className="chip warn plain">Illustrative band</span>}
          </div>
          <div className="panel-pad calc-inputs">
            <Field label="GPUs rented" value={gpus} onChange={setGpus} unit="GPUs" inputMode="numeric" error={g === null ? "Enter a whole number from 1 to 100,000." : null} />
            <Field label="Hours per month" value={hours} onChange={setHours} unit="hours" inputMode="numeric" hint="max 744" error={h === null ? "Enter a whole number from 1 to 744." : null} />
            <Field
              label="Current price"
              value={price}
              onChange={(v) => {
                setPriceTouched(true);
                setPrice(v);
                setScrub(null);
              }}
              unit="$/GPU-h"
              hint={indexPrice !== null ? "prefilled from the feed" : undefined}
              error={p === null ? "Enter a price such as 3.00." : null}
            />
            {!live ? (
              <>
                <div className="callout warn">
                  <strong>No series is deployed on this network yet.</strong> The band below is yours to set, so the maths can be explored. Once the market exists, its on-chain band replaces these fields.
                </div>
                <div className="ticket-row">
                  <Field label="Floor (L)" value={illLower} onChange={setIllLower} unit="$/GPU-h" />
                  <Field label="Cap (U)" value={illUpper} onChange={setIllUpper} unit="$/GPU-h" error={!bandOk ? "Cap must be above the floor." : null} />
                </div>
              </>
            ) : (
              <p className="sub num">
                Band from chain: {usd(snapshot.terms.lower, pd, 2)} to {usd(snapshot.terms.upper, pd, 2)} per GPU-hour
              </p>
            )}
            {!quote ? (
              <Field
                label="Assumed premium per claim"
                value={manualPremium}
                onChange={setManualPremium}
                unit="$ / claim"
                hint="optional"
                placeholder={calc ? `${fixed(intrinsic * 10n ** 6n / (calc.claims || 1n), 6, 4)}` : ""}
              />
            ) : null}
          </div>
        </div>

        <div className="stack calc-results">
          <div className="panel">
            <div className="results" aria-live="polite">
              <div className="result">
                <span className="label">Long claims to hold</span>
                <span className="figure num">{calc ? fixed(calc.claims, claimDecimals, 0) : "-"}</span>
                <span className="cap">
                  {g?.toString() ?? "?"} GPUs x {h?.toString() ?? "?"} h x ${(U - L).toFixed(2)} band width. Sized for the move between floor and cap only.
                </span>
              </div>
              <div className="result">
                <span className="label">{quote ? "Cost at current Kuru asks" : "Cost"}</span>
                {quote ? (
                  <>
                    <span className="figure num">{calc ? money(premium) : "-"}</span>
                    <span className="cap">
                      Best ask ${quote.bestAsk.toFixed(4)} per claim, {quote.bestSize.toLocaleString("en-US", { maximumFractionDigits: 0 })} claims at the top.
                      {quote.complete ? "" : " The visible book cannot fill this size; the figure covers only what is listed."}
                    </span>
                    <Src contract="Kuru OrderBook" address={config.kuru.longMarket} block={quote.block} />
                  </>
                ) : (
                  <>
                    <span className="figure num">{calc ? money(premium) : "-"}</span>
                    <span className="cap">
                      <strong>Kuru listing pending</strong>, so there is no ask to price against. Shown: {premiumBasis}.
                    </span>
                  </>
                )}
              </div>
              <div className="result">
                <span className="label">Maximum payout (the cap)</span>
                <span className="figure num">{calc ? money(maxPayout(calc.claims)) : "-"}</span>
                <span className="cap">Paid in full only if the index settles at or above ${U.toFixed(2)}. Nothing is paid beyond it.</span>
              </div>
              <div className="result">
                <span className="label">Bill held between floor and cap</span>
                <span className="figure num">{calc ? money(lockedMonthlyBill(calc.exposure) + premium) : "-"}</span>
                <span className="cap">GPUs x hours x ${L.toFixed(2)} plus the premium. Applies to any settlement price from ${L.toFixed(2)} to ${U.toFixed(2)}.</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="label">Monthly bill by settlement price</span>
              <span className="sub">premium basis: {premiumBasis}</span>
            </div>
            {calc ? (
              <>
                <div className="chart-wrap chart">
                  <HedgeChart exposure={calc.exposure} claims={calc.claims} premium={premium} today={today} scrub={scrub} domain={domain} onScrub={setScrub} />
                </div>
                <div className="legend">
                  <span><i className="dash" style={{ color: "var(--ink-3)" }} />Unhedged bill</span>
                  <span><i style={{ color: "var(--ink)", borderTopWidth: 3 }} />Hedged bill, premium included</span>
                  <span style={{ color: "var(--long)" }}>Shaded green: hedge saves money</span>
                  <span style={{ color: "var(--short)" }}>Shaded rust: premium costs more than the hedge pays</span>
                </div>
                <div className="scrub">
                  <label className="sr-only" htmlFor="scrub">Settlement price scenario</label>
                  <input
                    id="scrub"
                    type="range"
                    min={domain[0]}
                    max={domain[1]}
                    step={(domain[1] - domain[0]) / 400}
                    value={scrub}
                    onChange={(e) => setScrub(Number(e.target.value))}
                  />
                  {scrubRow ? (
                    <p className="num" style={{ fontSize: 13.5 }} aria-live="polite">
                      If the index settles at <strong>${scrub.toFixed(2)}</strong> ({regime === "in-band" ? "inside the band" : regime === "below" ? "below the floor" : "above the cap"}): unhedged {money(scrubRow.unhedged)}, claims pay {money(scrubRow.payout)}, net bill{" "}
                      <strong>{money(scrubRow.hedged)}</strong>.
                    </p>
                  ) : null}
                </div>
                <div className="scenarios">
                  {scenarios.map((s) => {
                    const o = row(s.price);
                    return (
                      <div key={s.key}>
                        <h4>{s.title}</h4>
                        <p className="fig num">at ${s.price.toFixed(2)}: unhedged {o ? money(o.unhedged) : "-"}</p>
                        <p className="fig num">claims pay {o ? money(o.payout) : "-"}, net {o ? money(o.hedged) : "-"}</p>
                        <p>{s.note}</p>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="panel-pad">
                <div className="pending"><strong>Fix the inputs above to plot the bill.</strong></div>
              </div>
            )}
          </div>
          {calc ? (
            <p className="callout">
              <strong>What this does and does not do.</strong> The claims pay a share of the index move between ${L.toFixed(2)} and ${U.toFixed(2)} and nothing above ${U.toFixed(2)}. They hedge the price gap, not your invoice, and they reserve no compute. Total claims in this hedge: {claimsWhole.toLocaleString("en-US", { maximumFractionDigits: 0 })}.
            </p>
          ) : null}
        </div>
        <div className="audience calc-audience">
          <div>
            <h4>Who buys the long</h4>
            <p>Inference startups that sell fixed-price plans on rented GPUs. When the hourly rate rises, the claims pay the difference.</p>
          </div>
          <div>
            <h4>Who takes the short</h4>
            <p>GPU owners and lenders hedging the rental value of their compute collateral. They earn the premium when rates stay below the cap.</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
