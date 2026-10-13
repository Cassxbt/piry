import { useState } from "react";
import type { Address } from "viem";
import { piryFaucetAbi } from "../abi";
import { chain, config, explorer } from "../config";
import { useAction, type ActionState } from "../hooks/action";
import { useClient } from "../hooks/chain";
import { useFaucet } from "../hooks/faucet";
import { useViewer } from "../hooks/viewer";
import { fixed } from "../lib/format";
import { faucetStatus, type FaucetStatus } from "../lib/faucet";
import { ActionButton, TxStatus } from "./Action";

export const MON_FAUCET_URL = "https://faucet.monad.xyz";
const DECIMALS = config.kuru.quoteDecimals;
const SYMBOL = config.kuru.quoteSymbol;

interface ViewProps {
  amount: bigint | undefined;
  faucetBalance: bigint | undefined;
  status: FaucetStatus;
  action: ActionState;
  button: React.ReactNode;
  address: Address;
}

const NOTE: Record<FaucetStatus, string> = {
  "no-wallet": "Connect a wallet to see whether it has already claimed.",
  claimed: "This wallet has already claimed. Each address can drip once.",
  empty: "The faucet is out of test USDC.",
  ready: "Not claimed yet. One drip per address.",
};

export function FaucetCardView({ amount, faucetBalance, status, action, button, address }: ViewProps) {
  const drip = amount !== undefined ? fixed(amount, DECIMALS, 0) : "100";
  const href = explorer.address(address);
  return (
    <div className="panel faucet" id="faucet">
      <div className="panel-head">
        <span className="label">Get {drip} test {SYMBOL}</span>
        <span className={`chip ${status === "ready" ? "ok" : "plain"}`}>{status === "claimed" ? "Claimed" : status === "empty" ? "Empty" : "Free"}</span>
      </div>
      <div className="panel-pad stack">
        <dl className="estimate">
          <div><dt>Faucet balance</dt><dd>{faucetBalance !== undefined ? `${fixed(faucetBalance, DECIMALS, 0)} ${SYMBOL}` : "reading"}</dd></div>
          <div><dt>Faucet contract</dt><dd>{href ? <a className="mono" href={href} target="_blank" rel="noreferrer">PiryFaucet</a> : <span className="mono">PiryFaucet</span>}</dd></div>
        </dl>
        <p className={`callout ${status === "claimed" ? "ok" : status === "empty" ? "warn" : ""}`} role="status">{NOTE[status]}</p>
        {button}
        <TxStatus state={action} />
        <p className="sub">
          You need a little MON for gas. Get it from the <a href={MON_FAUCET_URL} target="_blank" rel="noreferrer">official Monad testnet faucet</a>.
        </p>
      </div>
    </div>
  );
}

export function FaucetCard() {
  const faucet = config.faucet;
  const viewer = useViewer();
  const pc = useClient();
  const key = `${viewer.address}|${chain.id}|${faucet}`;
  const action = useAction(key);
  const [sentKey, setSentKey] = useState<string | null>(null);
  const read = useFaucet(viewer.connected ? viewer.address : undefined);
  if (!faucet) return null;

  const status = faucetStatus({ connected: viewer.connected, claimed: sentKey === key || read.data?.claimed, faucetBalance: read.data?.balance, amount: read.data?.amount });
  const drip = async () => {
    const hash = await action.run("Drip", async (op) => {
      const wallet = await op.wallet();
      const { request } = await pc.simulateContract({ account: wallet.account, address: faucet, abi: piryFaucetAbi, functionName: "drip" });
      op.guard();
      return wallet.writeContract(request);
    });
    if (hash) setSentKey(key);
  };

  return (
    <FaucetCardView
      address={faucet}
      amount={read.data?.amount}
      faucetBalance={read.data?.balance}
      status={status}
      action={action.state}
      button={<ActionButton label={`Get ${read.data ? fixed(read.data.amount, DECIMALS, 0) : "100"} test ${SYMBOL}`} busy={action.busy} disabled={status === "claimed" || status === "empty"} onRun={drip} />}
    />
  );
}
