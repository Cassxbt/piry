import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress, type Address } from "viem";
import { computeMarketAbi } from "../abi";
import { ActionButton, TxStatus } from "../components/Action";
import { Field } from "../components/Field";
import { Pending } from "../components/Pending";
import { Section } from "../components/Section";
import { Src } from "../components/Src";
import { chain, config } from "../config";
import { useAction } from "../hooks/action";
import { useClient, useHolder, useMark, useMarket } from "../hooks/chain";
import { useKuruAccount } from "../hooks/kuru";
import { useViewer } from "../hooks/viewer";
import { fixed, parseAmount, shortAddress, usd } from "../lib/format";
import { markLabel } from "../lib/labels";
import { previewRedeem } from "../lib/payout";
import type { MarketSnapshot } from "../lib/reads";

function Lookup() {
  const viewer = useViewer();
  const [text, setText] = useState("");
  if (viewer.connected) return null;
  const valid = isAddress(text.trim());
  return (
    <div className="addr-lookup">
      <Field
        label="Look up a holder without connecting"
        value={text}
        onChange={setText}
        inputMode="text"
        placeholder="0x..."
        error={text && !valid ? "Not a valid address." : null}
      />
      <button type="button" className="btn secondary" disabled={!valid} onClick={() => viewer.setLookup(text.trim() as Address)}>View</button>
      {viewer.lookup ? <button type="button" className="btn ghost" onClick={() => viewer.setLookup(undefined)}>Clear {shortAddress(viewer.lookup)}</button> : null}
    </div>
  );
}

function Totals({ snapshot }: { snapshot: MarketSnapshot }) {
  const mark = useMark();
  const { claims, state, collateral } = snapshot;
  const m = mark.data?.status === "ok" ? mark.data : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">The whole series, no wallet needed</span>
        <Src contract="ClaimToken, ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
      </div>
      <div className="totals">
        <div>
          <span className="label">Long outstanding</span>
          <span className="figure num">{fixed(claims.longSupply, claims.decimals)}</span>
          <span className="sub">{claims.longSymbol} total supply</span>
        </div>
        <div>
          <span className="label">Short outstanding</span>
          <span className="figure num">{fixed(claims.shortSupply, claims.decimals)}</span>
          <span className="sub">{claims.shortSymbol} total supply</span>
        </div>
        <div>
          <span className="label">Collateral locked</span>
          <span className="figure num">{fixed(state.collateralLocked, collateral.decimals)}</span>
          <span className="sub">{collateral.symbol} held by the market</span>
        </div>
        <div>
          <span className="label">{state.settled ? "Final long value" : "Long mark"}</span>
          <span className="figure num">{m ? markLabel(m.answer, m.decimals) : "n/a"}</span>
          <span className="sub">{m ? (m.isFinal ? "per claim, final" : "per claim, PiryMarkFeed") : mark.data?.status === "empty" ? "feed has no update yet" : "no feed reading"}</span>
        </div>
      </div>
    </div>
  );
}

export function Merge({ snapshot, pairs }: { snapshot: MarketSnapshot; pairs: bigint }) {
  const viewer = useViewer();
  const pc = useClient();
  const [amount, setAmount] = useState("");
  const action = useAction([viewer.address, chain.id, snapshot.address].join("|"), amount);
  const decimals = snapshot.claims.decimals;
  const quantity = parseAmount(amount, decimals);
  const error = quantity === null || quantity === 0n ? "Enter an amount." : quantity > pairs ? "More pairs than you hold." : null;

  const merge = () =>
    action.run("Merge", async (op) => {
      if (quantity === null) throw new Error("Enter an amount.");
      const wallet = await op.wallet();
      const { request } = await pc.simulateContract({ account: wallet.account, address: snapshot.address, abi: computeMarketAbi, functionName: "mergePairs", args: [quantity, wallet.account.address] });
      op.guard();
      return wallet.writeContract(request);
    });

  return (
    <div className="stack">
      <p className="sub">Equal long and short claims merge back into collateral one-for-one, before or after settlement. It is the only exit that never rounds.</p>
      <Field
        label="Pairs to merge"
        value={amount}
        onChange={setAmount}
        unit="pairs"
        hint={`you hold ${fixed(pairs, decimals)} full pairs`}
        error={amount && error ? error : null}
        trailing={pairs > 0n ? <button type="button" className="btn ghost small" onClick={() => setAmount(fixed(pairs, decimals, decimals).replace(/,/g, ""))}>Max</button> : null}
      />
      <ActionButton label="Merge pairs" variant="secondary" busy={action.busy} disabled={error !== null} onRun={merge} />
      <TxStatus state={action.state} />
    </div>
  );
}

export function Position() {
  const market = useMarket();
  const mark = useMark();
  const viewer = useViewer();
  const snapshot = market.data;
  const holder = useHolder(snapshot, viewer.address);
  const pc = useClient();
  const kuru = useKuruAccount(
    viewer.address,
    snapshot ? [snapshot.claims.long, snapshot.claims.short] : [],
  );

  const wallet = holder.data;
  const inKuru = (token: Address) => {
    const b = kuru.data?.balances.find((x) => x.token.toLowerCase() === token.toLowerCase());
    return b ? b.free + b.reserved : 0n;
  };
  const longTotal = snapshot && wallet ? wallet.long + inKuru(snapshot.claims.long) : undefined;
  const shortTotal = snapshot && wallet ? wallet.short + inKuru(snapshot.claims.short) : undefined;

  const answer = mark.data?.status === "ok" ? mark.data.answer : null;
  const feedDecimals = mark.data?.status === "ok" ? mark.data.decimals : 8;
  const unit = 10n ** BigInt(feedDecimals);
  const longMark = answer !== null ? answer : null;
  const shortMark = answer !== null ? (answer <= 1n ? unit : unit - answer) : null;
  const value = (amount: bigint | undefined, m: bigint | null) =>
    amount !== undefined && m !== null && snapshot ? usd((amount * m) / unit, snapshot.claims.decimals, 2) : null;

  const settledPreview = useQuery({
    queryKey: ["previewRedeem", snapshot?.address, wallet?.long.toString(), wallet?.short.toString(), snapshot?.state.settled],
    queryFn: () =>
      pc.readContract({ address: snapshot!.address, abi: computeMarketAbi, functionName: "previewRedeem", args: [wallet!.long, wallet!.short] }),
    enabled: snapshot?.state.settled === true && wallet !== undefined,
  });

  const band = snapshot ? { lower: snapshot.terms.lower, upper: snapshot.terms.upper } : null;
  const pairs = wallet ? (wallet.long < wallet.short ? wallet.long : wallet.short) : 0n;

  const illustrate = (price: bigint) => (wallet && band ? previewRedeem(wallet.long, wallet.short, price, band) : null);
  const mid = band ? band.lower + (band.upper - band.lower) / 2n : 0n;

  return (
    <Section
      id="position"
      index="4/6"
      kicker="Position"
      title={
        <>
          What you hold, what it is <em>marked</em> at, and how it exits
        </>
      }
      lede="Balances are read from the claim contracts; marks come from the PiryMarkFeed that exchanges use as their price source. Merging a pair is always available; redemption opens after settlement."
    >
      {!snapshot ? (
        <Pending title="No market deployed on this network yet">Positions appear once a ComputeMarket exists.</Pending>
      ) : (
        <div className="stack-lg">
          <Totals snapshot={snapshot} />
          <Lookup />
          {!viewer.address ? (
            <Pending title="Read-only mode">Connect a wallet, or paste an address above, to see long and short balances and their mark value.</Pending>
          ) : (
            <div className="two-col">
              <div className="panel">
                <div className="panel-head">
                  <span className="label">{viewer.connected ? "Your position" : `Position of ${shortAddress(viewer.address)}`}</span>
                  <Src contract="ClaimToken" address={snapshot.claims.long} block={wallet?.block ?? null} />
                </div>
                <div className="panel-pad">
                  <div className="holdings">
                    <div className="holding-row head">
                      <span>Claim</span><span className="r">Held</span><span className="r">Mark</span><span className="r">Value</span>
                    </div>
                    <div className="holding-row">
                      <span><strong>{snapshot.claims.longSymbol}</strong><br /><span className="sub">long, pays as the index rises</span></span>
                      <span className="r num" data-label="Held">{longTotal !== undefined ? fixed(longTotal, snapshot.claims.decimals) : "-"}</span>
                      <span className="r num" data-label="Mark">{longMark !== null ? markLabel(longMark, feedDecimals) : "n/a"}</span>
                      <span className="r num" data-label="Value">{value(longTotal, longMark) ?? "n/a"}</span>
                    </div>
                    <div className="holding-row">
                      <span><strong>{snapshot.claims.shortSymbol}</strong><br /><span className="sub">short, pays as it falls</span></span>
                      <span className="r num" data-label="Held">{shortTotal !== undefined ? fixed(shortTotal, snapshot.claims.decimals) : "-"}</span>
                      <span className="r num" data-label="Mark">{shortMark !== null ? usd(shortMark, feedDecimals, 4) : "n/a"}</span>
                      <span className="r num" data-label="Value">{value(shortTotal, shortMark) ?? "n/a"}</span>
                    </div>
                    <div className="holding-row">
                      <span>{snapshot.collateral.symbol}<br /><span className="sub">collateral in wallet</span></span>
                      <span className="r num" data-label="Held">{wallet ? fixed(wallet.collateral, snapshot.collateral.decimals) : "-"}</span>
                      <span className="r num" data-label="Mark">$1.00</span>
                      <span className="r num" data-label="Value">{wallet ? usd(wallet.collateral, snapshot.collateral.decimals, 2) : "-"}</span>
                    </div>
                  </div>
                  <div className="stack" style={{ marginTop: 16, gap: 6 }}>
                    {(config.kuru.longMarket || config.kuru.shortMarket) && wallet ? (
                      <p className="sub">Held includes {fixed(inKuru(snapshot.claims.long), snapshot.claims.decimals)} long and {fixed(inKuru(snapshot.claims.short), snapshot.claims.decimals)} short in your Kuru trading balance. Withdraw it to your wallet before redeeming.</p>
                    ) : null}
                    {answer === null ? (
                      <p className="sub">
                        {mark.data?.status === "empty" ? "The mark feed has no first update yet, so no mark value is shown." : "No mark feed is available for this series."}
                      </p>
                    ) : (
                      <p className="sub">Short mark is $1 minus the long mark, because a pair always merges back to $1. Long mark: PiryMarkFeed, 8 decimals.</p>
                    )}
                    {mark.data?.status === "ok" ? <Src contract="PiryMarkFeed" address={config.contracts.markFeed} block={mark.data.block} /> : null}
                  </div>
                </div>
              </div>

              <div className="stack">
                <div className="panel">
                  <div className="panel-head">
                    <span className="label">Redemption preview</span>
                    <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
                  </div>
                  <div className="panel-pad stack">
                    {snapshot.state.settled && wallet ? (
                      <>
                        <p className="figure num" style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 330 }}>
                          {settledPreview.data !== undefined ? usd(settledPreview.data, snapshot.collateral.decimals, 6) : "-"}
                        </p>
                        <p className="sub">
                          Redeeming all {fixed(wallet.long, snapshot.claims.decimals)} long and {fixed(wallet.short, snapshot.claims.decimals)} short in your wallet at the settled price.{" "}
                          {settledPreview.data !== undefined && band
                            ? previewRedeem(wallet.long, wallet.short, snapshot.state.settlementPrice, band) === settledPreview.data
                              ? "The contract's answer matches the local PayoutMath calculation."
                              : "Warning: the contract's answer differs from the local calculation."
                            : null}
                        </p>
                      </>
                    ) : wallet ? (
                      <>
                        <p className="sub">Not settled yet, so the exact amount is unknown. This table applies the contract&rsquo;s payout formula to your wallet claims at three settlement prices. It illustrates the formula; it is not a forecast.</p>
                        <table className="table">
                          <thead><tr><th>If the index settles at</th><th className="r">You would redeem</th></tr></thead>
                          <tbody>
                            {band
                              ? ([
                                  ["floor", band.lower],
                                  ["midpoint", mid],
                                  ["cap", band.upper],
                                ] as const).map(([name, p]) => (
                                  <tr key={name}>
                                    <td>{name} {usd(p, snapshot.terms.priceDecimals, 2)}</td>
                                    <td className="r num">{usd(illustrate(p) ?? 0n, snapshot.collateral.decimals, 2)}</td>
                                  </tr>
                                ))
                              : null}
                          </tbody>
                        </table>
                      </>
                    ) : (
                      <p className="sub">Reading balances.</p>
                    )}
                  </div>
                </div>
                {viewer.connected ? (
                  <div className="panel">
                    <div className="panel-head"><span className="label">Merge pairs</span></div>
                    <div className="panel-pad"><Merge snapshot={snapshot} pairs={pairs} /></div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
