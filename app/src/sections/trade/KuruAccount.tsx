import { useState } from "react";
import type { Address } from "viem";
import { ActionButton, TxStatus } from "../../components/Action";
import { Field } from "../../components/Field";
import { Src } from "../../components/Src";
import { config } from "../../config";
import { useAction } from "../../hooks/action";
import { useClient } from "../../hooks/chain";
import { useMarkFreshness } from "../../hooks/markFreshness";
import { kuruMarketFor, useKuruAccount, useOpenOrders, useWalletTokens, type KuruSide } from "../../hooks/kuru";
import { useViewer } from "../../hooks/viewer";
import { useWallet } from "../../hooks/wallet";
import { duration, fixed, parseAmount } from "../../lib/format";
import { cancelSlots, depositToKuru, openSession, withdrawFromKuru } from "../../lib/kuru";
import type { MarketSnapshot } from "../../lib/reads";

interface TokenRow {
  key: string;
  symbol: string;
  address: Address;
  decimals: number;
}

export function tokenRows(snapshot: MarketSnapshot): TokenRow[] {
  const rows: TokenRow[] = [
    { key: "quote", symbol: config.kuru.quoteSymbol, address: config.kuru.quoteToken, decimals: config.kuru.quoteDecimals },
    { key: "long", symbol: snapshot.claims.longSymbol, address: snapshot.claims.long, decimals: snapshot.claims.decimals },
  ];
  if (config.kuru.shortMarket) rows.push({ key: "short", symbol: snapshot.claims.shortSymbol, address: snapshot.claims.short, decimals: snapshot.claims.decimals });
  return rows;
}

function OpenOrders({ side, rootId, snapshot }: { side: KuruSide; rootId: bigint; snapshot: MarketSnapshot }) {
  const market = kuruMarketFor(side);
  const orders = useOpenOrders(side, rootId);
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  if (!market) return null;
  const symbol = side === "long" ? snapshot.claims.longSymbol : snapshot.claims.shortSymbol;

  const cancel = (slots: number[]) =>
    action.run("Cancel", async () => {
      if (!wallet) throw new Error("Connect a wallet first");
      const session = await openSession(pc, wallet, config.kuru.accountCore);
      return cancelSlots(session, market, rootId, slots);
    });

  return (
    <div className="stack">
      <div className="row between">
        <span className="label">Open orders: {symbol}/{config.kuru.quoteSymbol}</span>
        <Src contract="Kuru OrderBook" address={market} block={null} />
      </div>
      {orders.isLoading ? <p className="sub">Scanning your 62 order slots</p> : null}
      {orders.data && orders.data.length === 0 ? <p className="sub">No resting orders. A filled or cancelled order frees its slot.</p> : null}
      {orders.data?.map((o) => (
        <div className="row between" key={o.slot}>
          <span className="mono" style={{ fontSize: 13 }}>slot {o.slot} · order {o.orderId.toString()}</span>
          <ActionButton label="Cancel" size="small" variant="secondary" busy={action.busy} onRun={() => cancel([o.slot])} />
        </div>
      ))}
      <TxStatus state={action.state} />
    </div>
  );
}

export function KuruAccount({ snapshot }: { snapshot: MarketSnapshot }) {
  const viewer = useViewer();
  const rows = tokenRows(snapshot);
  const tokens = rows.map((r) => r.address);
  const account = useKuruAccount(viewer.address, tokens);
  const wallets = useWalletTokens(viewer.address, tokens);
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  const [selected, setSelected] = useState("quote");
  const [amount, setAmount] = useState("");
  const freshness = useMarkFreshness();

  const row = rows.find((r) => r.key === selected) ?? rows[0]!;
  const parsed = parseAmount(amount, row.decimals);
  const kuruFree = account.data?.balances.find((b) => b.token.toLowerCase() === row.address.toLowerCase())?.free ?? 0n;
  const inWallet = wallets.data?.[row.address.toLowerCase()] ?? 0n;

  const deposit = () =>
    action.run("Deposit", async () => {
      if (!wallet || parsed === null) throw new Error("Connect a wallet first");
      return depositToKuru(await openSession(pc, wallet, config.kuru.accountCore), row.address, parsed);
    });
  const withdraw = () =>
    action.run("Withdraw", async () => {
      if (!wallet || parsed === null) throw new Error("Connect a wallet first");
      return withdrawFromKuru(await openSession(pc, wallet, config.kuru.accountCore), row.address, parsed);
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Your Kuru trading balance</span>
        <Src contract="Kuru AccountCore" address={config.kuru.accountCore} block={account.data?.block ?? null} />
      </div>
      <div className="panel-pad stack-lg">
        <p className="sub">
          Kuru trades from a balance held inside its AccountCore, not from your wallet. Deposit first, trade, then withdraw. Bought claims arrive in this balance and must be withdrawn before you can redeem them.
        </p>
        {!viewer.address ? (
          <div className="pending"><strong>Connect a wallet or look up an address to see balances.</strong></div>
        ) : (
          <div className="holdings">
            <div className="holding-row head">
              <span>Token</span><span className="r">Wallet</span><span className="r">Kuru free</span><span className="r">Kuru reserved</span>
            </div>
            {rows.map((r) => {
              const b = account.data?.balances.find((x) => x.token.toLowerCase() === r.address.toLowerCase());
              return (
                <div className="holding-row" key={r.key}>
                  <span>{r.symbol}</span>
                  <span className="r num" data-label="Wallet">{wallets.data ? fixed(wallets.data[r.address.toLowerCase()] ?? 0n, r.decimals) : "-"}</span>
                  <span className="r num" data-label="Kuru free">{b ? fixed(b.free, r.decimals) : "-"}</span>
                  <span className="r num" data-label="Kuru reserved">{b ? fixed(b.reserved, r.decimals) : "-"}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="stack">
          <div className="segmented" role="group" aria-label="Token">
            {rows.map((r) => (
              <button key={r.key} type="button" aria-pressed={selected === r.key} onClick={() => setSelected(r.key)}>{r.symbol}</button>
            ))}
          </div>
          <Field
            label={`Amount of ${row.symbol}`}
            value={amount}
            onChange={setAmount}
            unit={row.symbol}
            hint={`wallet ${fixed(inWallet, row.decimals)} · Kuru ${fixed(kuruFree, row.decimals)}`}
            error={amount && parsed === null ? "Enter a valid amount." : null}
          />
          <div className="row">
            <ActionButton label={`Deposit ${row.symbol}`} busy={action.busy} disabled={parsed === null || parsed === 0n || parsed > inWallet} onRun={deposit} />
            <ActionButton label={`Withdraw ${row.symbol}`} variant="secondary" busy={action.busy} disabled={parsed === null || parsed === 0n || parsed > kuruFree} onRun={withdraw} />
          </div>
          {freshness.stale && row.key !== "quote" ? (
            <div className="callout warn" role="status">
              <strong>Stale mark: claim deposits and withdrawals may revert.</strong> The feed was last updated {freshness.ageSeconds !== null ? `${duration(freshness.ageSeconds)} ago` : "a while ago"}. Kuru&rsquo;s price check needs a fresh mark (under 30 min); the keeper refreshes it every few minutes, so try again shortly.
            </div>
          ) : null}
          <TxStatus state={action.state} />
          <p className="sub">Claim deposits and withdrawals also pass Kuru&rsquo;s shared limiter and need a fresh price for the token, so they can revert even when the balance is there.</p>
        </div>
        {account.data && account.data.rootId > 0n ? (
          <>
            <OpenOrders side="long" rootId={account.data.rootId} snapshot={snapshot} />
            {config.kuru.shortMarket ? <OpenOrders side="short" rootId={account.data.rootId} snapshot={snapshot} /> : null}
          </>
        ) : viewer.address ? (
          <p className="sub">No Kuru account yet for this address. The first deposit creates it.</p>
        ) : null}
      </div>
    </div>
  );
}
