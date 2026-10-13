import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { computeMarketAbi } from "../abi";
import { ActionButton, TxStatus } from "../components/Action";
import { Field } from "../components/Field";
import { Pending } from "../components/Pending";
import { Section } from "../components/Section";
import { Src } from "../components/Src";
import { TxLink } from "./evidence/shared";
import { useAction } from "../hooks/action";
import { useClient, useHolder, useMarket } from "../hooks/chain";
import { primarySubject } from "../config";
import { useLifecycle } from "../hooks/lifecycle";
import { useViewer } from "../hooks/viewer";
import { useWallet } from "../hooks/wallet";
import { blockLabel, fixed, parseAmount, shortAddress, usd, utc } from "../lib/format";
import { payouts, previewRedeem, roundingLoss } from "../lib/payout";
import type { MarketSnapshot } from "../lib/reads";

type Guard = "exact" | "custom";

function RedeemForm({ snapshot }: { snapshot: MarketSnapshot }) {
  const viewer = useViewer();
  const holder = useHolder(snapshot, viewer.address);
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  const { decimals } = snapshot.claims;
  const cd = snapshot.collateral.decimals;
  const held = holder.data;

  const [longText, setLong] = useState("");
  const [shortText, setShort] = useState("");
  const [touched, setTouched] = useState(false);
  const [guard, setGuard] = useState<Guard>("exact");
  const [customMin, setCustomMin] = useState("");

  useEffect(() => {
    if (touched) return;
    if (held) {
      setLong(fixed(held.long, decimals, decimals).replace(/,/g, ""));
      setShort(fixed(held.short, decimals, decimals).replace(/,/g, ""));
    } else if (!viewer.address) {
      setLong("100");
      setShort("0");
    }
  }, [held, touched, decimals, viewer.address]);

  const longAmount = parseAmount(longText || "0", decimals);
  const shortAmount = parseAmount(shortText || "0", decimals);
  const valid = longAmount !== null && shortAmount !== null && (longAmount > 0n || shortAmount > 0n);
  const overLong = held !== undefined && longAmount !== null && longAmount > held.long;
  const overShort = held !== undefined && shortAmount !== null && shortAmount > held.short;

  const band = { lower: snapshot.terms.lower, upper: snapshot.terms.upper };
  const price = snapshot.state.settlementPrice;
  const local = valid ? previewRedeem(longAmount, shortAmount, price, band) : null;
  const onchain = useQuery({
    queryKey: ["redeem-preview", snapshot.address, longAmount?.toString(), shortAmount?.toString()],
    queryFn: () => pc.readContract({ address: snapshot.address, abi: computeMarketAbi, functionName: "previewRedeem", args: [longAmount as bigint, shortAmount as bigint] }),
    enabled: valid,
  });

  const customMinParsed = parseAmount(customMin || "0", cd);
  const minPayout = guard === "exact" ? (onchain.data ?? null) : customMinParsed;
  const longLeg = valid ? payouts(longAmount, price, band).long : 0n;
  const shortLeg = valid ? payouts(shortAmount, price, band).short : 0n;
  const total = longLeg + shortLeg;
  const loss = valid ? roundingLoss(longAmount, shortAmount, price, band) : { numerator: 0n, width: 1n };
  const lossUnits = Number((loss.numerator * 1000n) / loss.width) / 1000;

  const redeem = () =>
    action.run("Redeem", async () => {
      const account = wallet?.account;
      if (!wallet || !account || !valid || minPayout === null) throw new Error("Connect a wallet and enter amounts first");
      const { request } = await pc.simulateContract({
        account,
        address: snapshot.address,
        abi: computeMarketAbi,
        functionName: "redeem",
        args: [longAmount, shortAmount, account.address, minPayout],
      });
      return wallet.writeContract(request);
    });

  const blocker =
    !viewer.connected ? null
    : overLong ? `You hold only ${fixed(held!.long, decimals)} long in your wallet.`
    : overShort ? `You hold only ${fixed(held!.short, decimals)} short in your wallet.`
    : !valid ? "Enter an amount to redeem."
    : onchain.isError ? "The contract refused this preview."
    : minPayout === null ? "Enter a minimum payout."
    : null;

  return (
    <div className="redeem">
      <div className="panel">
        <div className="panel-head">
          <span className="label">Redeem at the settled price</span>
          <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
        </div>
        <div className="panel-pad stack">
          {!viewer.address ? <p className="callout">Preview mode. These amounts are an example: <span className="mono">previewRedeem</span> is a read-only call, so it answers without a wallet. Connect one to redeem real claims.</p> : null}
          <div className="ticket-row">
            <Field
              label={`${snapshot.claims.longSymbol} to redeem`}
              value={longText}
              onChange={(v) => { setTouched(true); setLong(v); }}
              unit="long"
              hint={held ? `wallet ${fixed(held.long, decimals)}` : undefined}
              error={longAmount === null ? "Enter a valid amount." : overLong ? "More than your wallet holds." : null}
            />
            <Field
              label={`${snapshot.claims.shortSymbol} to redeem`}
              value={shortText}
              onChange={(v) => { setTouched(true); setShort(v); }}
              unit="short"
              hint={held ? `wallet ${fixed(held.short, decimals)}` : undefined}
              error={shortAmount === null ? "Enter a valid amount." : overShort ? "More than your wallet holds." : null}
            />
          </div>

          <div className="field">
            <div className="label-row"><span>Minimum payout protection</span></div>
            <div className="segmented fill" role="group" aria-label="Minimum payout">
              <button type="button" aria-pressed={guard === "exact"} onClick={() => setGuard("exact")}>Exactly the preview</button>
              <button type="button" aria-pressed={guard === "custom"} onClick={() => setGuard("custom")}>Custom minimum</button>
            </div>
          </div>
          {guard === "custom" ? (
            <Field label="Revert if the payout is below" value={customMin} onChange={setCustomMin} unit={snapshot.collateral.symbol} error={customMinParsed === null ? "Enter a valid amount." : null} />
          ) : null}
          <p className="sub">
            The transaction reverts with MinimumPayoutNotMet if the payout would fall below this. A zero minimum would permit a zero-output burn, so the default is the contract&rsquo;s own preview.
          </p>

          <ActionButton label="Redeem" busy={action.busy} disabled={blocker !== null} onRun={redeem} block />
          {blocker ? <p className="sub" role="status">{blocker}</p> : null}
          <TxStatus state={action.state} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="label">What you receive</span></div>
        <div className="panel-pad stack">
          <div>
            <p className="label">Contract preview</p>
            <p className="num" style={{ fontFamily: "var(--font-display)", fontSize: 38, fontWeight: 320, letterSpacing: "-0.02em" }}>
              {onchain.data !== undefined ? usd(onchain.data, cd, 6) : valid ? "reading" : "-"}
            </p>
            <p className="sub">
              {valid && onchain.data !== undefined && local !== null
                ? onchain.data === local
                  ? "previewRedeem agrees with the local PayoutMath calculation, to the unit."
                  : "Warning: previewRedeem differs from the local calculation."
                : "previewRedeem(long, short) on the market contract."}
            </p>
          </div>
          {valid ? (
            <>
              <div className="split" role="img" aria-label={`Long leg pays ${fixed(longLeg, cd, 2)}, short leg pays ${fixed(shortLeg, cd, 2)}`}>
                <i className="l" style={{ width: total > 0n ? `${Number((longLeg * 10000n) / total) / 100}%` : "0%" }} />
                <i className="s" style={{ width: total > 0n ? `${Number((shortLeg * 10000n) / total) / 100}%` : "0%" }} />
              </div>
              <dl className="estimate">
                <div><dt>Long leg</dt><dd>{usd(longLeg, cd, 6)}</dd></div>
                <div><dt>Short leg</dt><dd>{usd(shortLeg, cd, 6)}</dd></div>
                <div><dt>Settled price</dt><dd>{usd(price, snapshot.terms.priceDecimals, 6)}</dd></div>
                <div><dt>Rounded away (each leg floors)</dt><dd>{lossUnits.toFixed(3)} base units</dd></div>
              </dl>
              <p className="sub">
                long = floor(q x clamp(P - L, 0, U - L) / (U - L)); short is the mirror image. Merging matched pairs instead of redeeming them separately avoids the rounding.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PriorRedemptions({ snapshot }: { snapshot: MarketSnapshot }) {
  const lifecycle = useLifecycle(snapshot, primarySubject);
  const rows = (lifecycle.data?.steps ?? []).flatMap(({ proof }) => (proof ? proof.redemptions.map((r) => ({ proof, r })) : []));
  if (rows.length === 0) return null;
  const cd = snapshot.collateral.decimals;
  const dec = snapshot.claims.decimals;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Redemptions already made on this series</span>
        <Src contract="ComputeMarket Redeemed" address={snapshot.address} block={snapshot.block.number} />
      </div>
      <div className="panel-pad stack">
        <p className="sub">Read from the <span className="mono">Redeemed</span> event in each transaction&rsquo;s receipt, not from the run log.</p>
        <div className="table-wrap">
          <table className="table responsive">
            <thead><tr><th>Transaction</th><th className="r">Long burned</th><th className="r">Short burned</th><th className="r">Paid out</th><th>Block</th></tr></thead>
            <tbody>
              {rows.map(({ proof, r }) => (
                <tr key={proof.hash}>
                  <td data-label="Transaction"><span><TxLink hash={proof.hash} /><span className="sub" style={{ display: "block" }}>to {shortAddress(r.recipient)}</span></span></td>
                  <td className="r num" data-label="Long burned">{fixed(r.long, dec)}</td>
                  <td className="r num" data-label="Short burned">{fixed(r.short, dec)}</td>
                  <td className="r num" data-label="Paid out">{usd(r.payout, cd, 6)}</td>
                  <td className="num" data-label="Block"><span>{blockLabel(proof.blockNumber)}<span className="sub" style={{ display: "block" }}>{utc(proof.timestamp)}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function Redeem() {
  const market = useMarket();
  const snapshot = market.data;
  return (
    <Section
      id="redeem"
      index="6/6"
      kicker="Redeem"
      title={
        <>
          Burn claims, receive collateral, <em>protected</em> by a minimum
        </>
      }
      lede="Redemption opens the moment the market settles. The contract burns the claims you hold and pays each leg its fixed share of collateral; you choose the lowest payout you will accept."
    >
      {!snapshot ? (
        <Pending title="No market deployed on this network yet">Redemption appears once a ComputeMarket exists and has settled.</Pending>
      ) : !snapshot.state.settled ? (
        <div className="stack">
          <Pending title="Redemption opens at settlement">
            The market has not settled, so the contract will refuse to redeem (NotSettled). Matched long and short pairs can still be merged back into collateral from the Position step at any time.
          </Pending>
        </div>
      ) : (
        <div className="stack-lg">
          <RedeemForm snapshot={snapshot} />
          <PriorRedemptions snapshot={snapshot} />
        </div>
      )}
    </Section>
  );
}
