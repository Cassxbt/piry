import { useState } from "react";
import { erc20Abi } from "viem";
import { ActionButton, TxStatus } from "../../components/Action";
import { Field } from "../../components/Field";
import { Src } from "../../components/Src";
import { config } from "../../config";
import { computeMarketAbi } from "../../abi";
import { useAction } from "../../hooks/action";
import { useClient, useChainNow, useHolder, useMarket } from "../../hooks/chain";
import { useViewer } from "../../hooks/viewer";
import { useWallet } from "../../hooks/wallet";
import { fixed, parseAmount } from "../../lib/format";
import { confirmed } from "../../lib/kuru";
import type { MarketSnapshot } from "../../lib/reads";

export function MintCard({ snapshot }: { snapshot: MarketSnapshot }) {
  const viewer = useViewer();
  const market = useMarket();
  const holder = useHolder(snapshot, viewer.address);
  const now = useChainNow(snapshot, market.dataUpdatedAt);
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  const [amount, setAmount] = useState("100");

  const { symbol, decimals } = snapshot.collateral;
  const isKuruToken = snapshot.collateral.address.toLowerCase() === config.kuru.quoteToken.toLowerCase();
  const help = isKuruToken ? config.collateralHelp.kuruToken : config.collateralHelp.deployerToken;
  const quantity = parseAmount(amount, decimals);
  const balance = holder.data?.collateral;
  const allowance = holder.data?.collateralAllowance ?? 0n;
  const closed = (now ?? snapshot.block.timestamp) >= snapshot.terms.periodEnd;
  const short = quantity !== null && balance !== undefined && quantity > balance;
  const error = quantity === null || quantity === 0n ? "Enter an amount." : short ? `More than your ${symbol} balance.` : null;

  const mint = () =>
    action.run("Mint", async () => {
      const account = wallet?.account;
      if (!wallet || !account || quantity === null) throw new Error("Connect a wallet first");
      if (allowance < quantity) {
        const approve = await pc.simulateContract({ account, address: snapshot.collateral.address, abi: erc20Abi, functionName: "approve", args: [snapshot.address, quantity] });
        await confirmed(pc, await wallet.writeContract(approve.request));
      }
      const mintRequest = await pc.simulateContract({ account, address: snapshot.address, abi: computeMarketAbi, functionName: "mintPairs", args: [quantity] });
      return wallet.writeContract(mintRequest.request);
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Mint a pair</span>
        <Src contract="ComputeMarket" address={snapshot.address} block={snapshot.block.number} />
      </div>
      <div className="panel-pad stack">
        <p className="sub">
          Deposit {symbol} and receive the same quantity of {snapshot.claims.longSymbol} and {snapshot.claims.shortSymbol}. This is how the short side is created: keep the short, sell the long to the book. A pair can always be merged back into collateral.
        </p>
        <Field
          label="Collateral to deposit"
          value={amount}
          onChange={setAmount}
          unit={symbol}
          hint={balance !== undefined ? `balance ${fixed(balance, decimals)}` : viewer.address ? "reading balance" : "connect to see balance"}
          error={amount && error ? error : null}
          trailing={
            balance !== undefined && balance > 0n ? (
              <button type="button" className="btn ghost small" onClick={() => setAmount(fixed(balance, decimals, decimals).replace(/,/g, ""))}>Max</button>
            ) : null
          }
        />
        {quantity !== null && quantity > 0n ? (
          <dl className="estimate">
            <div><dt>You deposit</dt><dd>{fixed(quantity, decimals)} {symbol}</dd></div>
            <div><dt>You receive</dt><dd>{fixed(quantity, snapshot.claims.decimals)} long + {fixed(quantity, snapshot.claims.decimals)} short</dd></div>
            <div><dt>Approval</dt><dd>{allowance >= quantity ? "already granted" : "needed first (one extra transaction)"}</dd></div>
          </dl>
        ) : null}
        {balance === 0n && viewer.connected ? (
          <p className="callout warn">This wallet holds no {symbol}. {help}</p>
        ) : (
          <p className="sub">{help}</p>
        )}
        {closed ? <p className="callout bad">Minting closed when the period ended.</p> : null}
        <ActionButton label="Mint pair" busy={action.busy} disabled={closed || error !== null} onRun={mint} />
        <TxStatus state={action.state} />
      </div>
    </div>
  );
}
