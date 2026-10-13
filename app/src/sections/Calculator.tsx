import { useEffect, useMemo, useState } from "react";
import { TimingNote } from "../components/live/TimingNote";
import { Field } from "../components/Field";
import { ForwardLock } from "../components/live/ForwardLock";
import { OtherSide } from "../components/live/OtherSide";
import { ScenarioChart } from "../components/charts/lazy";
import { Section } from "../components/Section";
import { Src } from "../components/Src";
import { config, primarySubject } from "../config";
import { useMark, useMarket, useSeriesShortMark } from "../hooks/chain";
import { hedgeBasisNote, useExampleSize, useHedgeQuote } from "../hooks/hedgeQuote";
import { breakEvenIndex, chartDomain, claimsToHold, lockedMonthlyBill, lockedOwnerIncome, maxPayout, outcomeFor, regimeOf, type Exposure, type HedgeSide } from "../lib/hedge";
import { fixed, parseAmount, usd } from "../lib/format";
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

  const [side, setSide] = useState<HedgeSide>("renter");
  const owner = side === "owner";
  const [gpus, setGpus] = useState("8");
  const [hours, setHours] = useState("720");
  const [sizeTouched, setSizeTouched] = useState(false);
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

  const claimToken = snapshot ? (owner ? snapshot.claims.short : snapshot.claims.long) : undefined;
  const example = useExampleSize(lower !== null && upper !== null && lower < upper ? { band: { lower, upper }, priceDecimals: pd, collateralDecimals: cd } : null, claimToken, owner ? "short" : "long");
  useEffect(() => {
    if (sizeTouched) return;
    setGpus(example.gpus.toString());
    setHours(example.hours.toString());
  }, [example.gpus, example.hours, sizeTouched]);

  const g = integerOrNull(gpus, 100_000);
  const h = integerOrNull(hours, 744);
  const p = parseAmount(price, pd);
  const bandOk = lower !== null && upper !== null && lower < upper;
  const inputsOk = g !== null && h !== null && p !== null && bandOk;

  const calc = useMemo(() => {
    if (!inputsOk || lower === null || upper === null) return null;
    const exposure: Exposure = { gpus: g, hours: h, band: { lower, upper }, priceDecimals: pd, collateralDecimals: cd };
    const claims = claimsToHold(exposure);
    return { exposure, claims };
  }, [inputsOk, g, h, lower, upper, pd, cd]);

  const shortMark = useSeriesShortMark(primarySubject);
  const markData = owner ? shortMark.data : mark.data;
  const feedMark = markData?.status === "ok" ? { value: markData.answer, scale: 10n ** 8n } : null;
  const hedgeQuote = useHedgeQuote(calc ? calc.claims : null, feedMark, cd, owner ? "short" : "long", claimToken);
  const quote = hedgeQuote && (hedgeQuote.basis !== "mark" || feedMark) ? hedgeQuote : null;

  const intrinsic = useMemo(() => (calc && p !== null ? payouts(calc.claims, p, calc.exposure.band)[owner ? "short" : "long"] : 0n), [calc, p, owner]);

  const manual = parseAmount(manualPremium, 6);
  const claimsWhole = calc ? Number(calc.claims) / 10 ** claimDecimals : 0;
  const premium = quote ? quote.premium : manual !== null && calc ? (calc.claims * manual) / 10n ** 6n : intrinsic;
  const premiumBasis = quote
    ? { book: "Kuru asks, fee included", "book+mark": "Kuru asks, remainder at the feed mark (illustrative)", "book-partial": "Kuru asks (partial)", mark: "feed mark, illustrative" }[quote.basis]
    : manual !== null ? "your assumed price" : "intrinsic reference, not a quote";

  const L = lower !== null ? Number(lower) / 10 ** pd : 0;
  const U = upper !== null ? Number(upper) / 10 ** pd : 1;
  const today = p !== null ? Number(p) / 10 ** pd : (L + U) / 2;
  const domain = chartDomain(L, U, today);
  const scrub = scrubOverride ?? today;

  const money = (raw: bigint) => usd(raw, cd, 0);
  const row = (price: number) => {
    if (!calc) return null;
    return outcomeFor(side, calc.exposure, calc.claims, premium, BigInt(Math.round(price * 10 ** pd)));
  };
  const span = U - L;
  const scenarios = !calc
    ? []
    : owner
      ? ([
          { key: "below", title: "Below the floor", price: Math.max(0.01, L - span * 0.5), note: "The short has paid its maximum. Each further dollar of fall comes out of your income: protection stops at the floor." },
          { key: "in-band", title: "Inside the band", price: (L + U) / 2, note: "Every dollar the rate falls is paid back by the short claims, so the income stays flat." },
          { key: "above", title: "Above the cap", price: U + span * 0.5, note: "The short pays nothing. You keep the higher rental income and lose the premium." },
        ] as const)
      : ([
          { key: "below", title: "Below the floor", price: Math.max(0.01, L - span * 0.5), note: "The long pays nothing. You keep the cheaper GPUs and lose the premium." },
          { key: "in-band", title: "Inside the band", price: (L + U) / 2, note: "Every extra dollar of GPU price is paid back by the claims, so the bill stays flat." },
          { key: "above", title: "Above the cap", price: U + span * 0.5, note: "The claims have paid their maximum. Each further dollar comes out of your pocket." },
        ] as const);
  const noun = owner ? "income" : "bill";

  const costPerClaim = calc && calc.claims > 0n ? Number(premium) / Number(calc.claims) * 10 ** (claimDecimals - cd) : null;
  const breakEven = costPerClaim !== null && lower !== null && upper !== null ? breakEvenIndex(owner ? "short" : "long", costPerClaim, { lower: L, upper: U }) : null;
  const scrubRow = row(scrub);
  const regime = lower !== null && upper !== null ? regimeOf(BigInt(Math.round(scrub * 10 ** pd)), { lower, upper }) : "in-band";

  return (
    <Section
      id="exposure"
      index="2/6"
      kicker="Exposure"
      title={
        <>
          Size the hedge, and see <em>exactly</em> where it stops
        </>
      }
      lede={
        owner
          ? "Enter the GPUs you own or finance. The calculator sizes the short claims that offset a fall in rental income inside the band, prices them against the live Kuru book, and plots your income re-priced at the settlement-day rate, with and without them."
          : "Enter the GPUs you rent. The calculator sizes the long claims that offset the bill increase inside the band, prices them against the live Kuru book, and plots your bill re-priced at the settlement-day rate, with and without them."
      }
    >
      <div className="side-toggle" role="group" aria-label="Which side of the market are you on">
        <button type="button" className={`btn small ${owner ? "secondary" : ""}`} aria-pressed={!owner} onClick={() => { setSide("renter"); setScrub(null); }}>I rent GPUs</button>
        <button type="button" className={`btn small ${owner ? "" : "secondary"}`} aria-pressed={owner} onClick={() => { setSide("owner"); setScrub(null); }}>I own or finance GPUs</button>
      </div>
      {owner ? (
        <p className="sub side-thesis">
          Worked example: financed H100s whose rental income falls if rates drop. GPU-backed lenders &ldquo;hold several billion dollars&rsquo; worth of GPUs on balance sheets with no coherent way to hedge&rdquo; (<a href="https://www.galaxy.com/insights/perspectives/backing-ornn-the-financial-layer-for-compute" target="_blank" rel="noreferrer">Galaxy</a>). Buying short claims (PIRY-S) sized GPU-hours x band width pays when the index settles low.
        </p>
      ) : null}
      <div className="calc">
        <div className="panel">
          <div className="panel-head">
            <span className="label">Your exposure</span>
            {live ? <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} /> : <span className="chip warn plain">Illustrative band</span>}
          </div>
          <div className="panel-pad calc-inputs">
            <Field label={owner ? "GPUs owned or financed" : "GPUs rented"} value={gpus} onChange={(v) => { setSizeTouched(true); setGpus(v); }} unit="GPUs" inputMode="numeric" error={g === null ? "Enter a whole number from 1 to 100,000." : null} />
            <Field label={owner ? "Hours rented out per month" : "Hours per month"} value={hours} onChange={(v) => { setSizeTouched(true); setHours(v); }} unit="hours" inputMode="numeric" hint="max 744" error={h === null ? "Enter a whole number from 1 to 744." : null} />
            {sizeTouched ? (
              <button type="button" className="btn secondary small" onClick={() => setSizeTouched(false)}>Size from the book</button>
            ) : (
              <p className="sub">Starting size: the largest example the visible Kuru book fills in full right now. Change it to size your own exposure.</p>
            )}
            <Field
              label={owner ? "Current rental price" : "Current price"}
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
                <span className="label">{owner ? "Short claims to hold" : "Long claims to hold"}</span>
                <span className="figure num">{calc ? fixed(calc.claims, claimDecimals, 0) : "-"}</span>
                <span className="cap">
                  Hedge size = GPU-hours of exposure x band width. {g !== null && h !== null ? `${(g * h).toLocaleString("en-US")} GPU-hours` : "GPU-hours"} x ${(U - L).toFixed(2)} = {calc ? fixed(calc.claims, claimDecimals, 0) : "?"} claims, each paying up to $1. It covers the move between floor and cap only.
                </span>
              </div>
              <div className="result">
                <span className="label">{quote ? "Executable now from the Kuru book" : "Cost"}</span>
                {quote ? (
                  <>
                    <span className="figure num">{calc ? money(quote.executableCost) : "-"}</span>
                    <span className="cap">
                      {quote.filled > 0n
                        ? `${fixed(quote.filled, claimDecimals, 2)} claims at an average ask of $${(quote.avgAsk ?? 0).toFixed(4)}, plus the ${(quote.takerFeePct ?? 0).toFixed(2)}% taker fee (${usd(quote.fee, cd, 2)}). `
                        : quote.issues.length > 0 ? "" : "The book cannot fill any of this size now. "}
                      {quote.bestAsk !== null && quote.bestSize !== null ? `Best ask $${quote.bestAsk.toFixed(4)}, ${quote.bestSize.toLocaleString("en-US", { maximumFractionDigits: 0 })} claims at the top. ` : ""}
                      {hedgeBasisNote(quote, claimDecimals)}
                    </span>
                    {quote.remainder > 0n ? (
                      <span className="cap">
                        <strong>Illustrative remainder:</strong> {fixed(quote.remainder, claimDecimals, 2)} claims at the feed mark would add about {money(quote.remainderCost)}, for a full-hedge figure of {money(quote.premium)}. This is an estimate, not a quote.
                      </span>
                    ) : null}
                    {quote.block !== null ? <Src contract="Kuru OrderBook" address={owner ? config.kuru.shortMarket : config.kuru.longMarket} block={quote.block} /> : null}
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
                <span className="cap">{owner ? `Paid in full only if the index settles at or below $${L.toFixed(2)}. Nothing is paid beyond it.` : `Paid in full only if the index settles at or above $${U.toFixed(2)}. Nothing is paid beyond it.`}</span>
              </div>
              <div className="result">
                <span className="label">{owner ? "Income held between floor and cap" : "Bill held between floor and cap"}</span>
                <span className="figure num">{calc ? money(owner ? lockedOwnerIncome(calc.exposure) - premium : lockedMonthlyBill(calc.exposure) + premium) : "-"}</span>
                <span className="cap">{owner ? `GPUs x hours x $${U.toFixed(2)} less the full-hedge cost. Applies to any settlement price from $${L.toFixed(2)} to $${U.toFixed(2)}; below $${L.toFixed(2)} income falls with the market.` : `GPUs x hours x $${L.toFixed(2)} plus the full-hedge cost. Applies to any settlement price from $${L.toFixed(2)} to $${U.toFixed(2)}.`}</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="label">{owner ? "Income by settlement price" : "Bill by settlement price"}</span>
              <span className="sub">premium basis: {premiumBasis}</span>
            </div>
            {calc ? (
              <>
                <div className="chart-wrap">
                  <ScenarioChart exposure={calc.exposure} claims={calc.claims} premium={premium} today={today} scrub={scrub} domain={domain} onScrub={setScrub} surface="sheet" side={side} />
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
                      If the index settles at <strong>${scrub.toFixed(2)}</strong> ({regime === "in-band" ? "inside the band" : regime === "below" ? "below the floor" : "above the cap"}): unhedged {money(scrubRow.unhedged)}, claims pay {money(scrubRow.payout)}, net {noun}{" "}
                      <strong>{money(scrubRow.hedged)}</strong>.
                    </p>
                  ) : null}
                </div>
                <div className="scenarios">
                  {scenarios.map((s) => {
                    const o = row(s.price);
                    return (
                      <div key={s.key}>
                        <h3>{s.title}</h3>
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
          <TimingNote periodEnd={snapshot?.terms.periodEnd} />
          {calc && p !== null && lower !== null && upper !== null && p >= lower && p <= upper ? (
            <ForwardLock exposure={calc.exposure} claims={calc.claims} premium={premium} today={today} side={side} />
          ) : null}
          {calc ? (
            <p className="callout">
              <strong>What this does and does not do.</strong> {owner ? `The short claims pay a share of the index fall between $${U.toFixed(2)} and $${L.toFixed(2)} and nothing below $${L.toFixed(2)}.` : `The claims pay a share of the index move between $${L.toFixed(2)} and $${U.toFixed(2)} and nothing above $${U.toFixed(2)}.`} They hedge the price gap, not your invoice, and they reserve no compute. Total claims in this hedge: {claimsWhole.toLocaleString("en-US", { maximumFractionDigits: 0 })}.
              {breakEven !== null ? ` At this cost the claims alone break even if the index settles ${owner ? "at or below" : "at or above"} $${breakEven.toFixed(4)}; the hedge's value is the flat region, not a profit.` : ""}
            </p>
          ) : null}
          {snapshot && lower !== null && upper !== null ? <OtherSide snapshot={snapshot} scrub={scrub} /> : null}
        </div>
        <div className="audience calc-audience">
          <div>
            <h4>Who buys the long</h4>
            <p>Inference startups that sell fixed-price plans on rented GPUs. When the hourly rate rises, the claims pay the difference.</p>
          </div>
          <div>
            <h4>Who takes the short</h4>
            <p>GPU owners and lenders hedging the rental value of their compute collateral buy the short claims and pay the premium. Whoever sells them the short is the one taking the other side of the index.</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
