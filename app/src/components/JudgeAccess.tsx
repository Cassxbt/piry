import { useState } from "react";
import { chain, config } from "../config";
import judgeAccess from "../config/judge-access.json";
import { parseJudgeWallets, type JudgeWallet } from "../lib/judge";

interface Network {
  name: string;
  id: number;
  rpcUrl: string;
  symbol: string;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      setDone(false);
    }
  };
  return (
    <button type="button" className="btn small secondary" onClick={copy} aria-label={`Copy ${label}`}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function JudgeAccessView({ wallets, network }: { wallets: JudgeWallet[]; network: Network }) {
  return (
    <div className="judge-access brackets" id="judge-access">
      <p className="mono kicker-line"><i className="sq" aria-hidden />FOR JUDGES: TRY PIRY IN 2 MINUTES</p>
      <ol className="judge-steps">
        <li>
          <strong>Add {network.name} to MetaMask</strong> (chain id <span className="mono">{network.id}</span>, currency <span className="mono">{network.symbol}</span>, RPC <span className="mono">{network.rpcUrl}</span>), or let the app prompt you when you connect.
        </li>
        <li>
          <strong>Import into MetaMask (testnet only):</strong> account menu, Add account or hardware wallet, Import account, then paste the private key for one of the wallets below. Each wallet is pre-funded with test {network.symbol} and test USDC.
        </li>
        <li>
          <strong>Walk the app:</strong> size a hedge (step 2), mint a pair or place a limit order on Kuru (step 3), check your position (step 4), then see the evidence and redeem. Reading everything works without a wallet.
        </li>
      </ol>

      {wallets.length === 0 ? (
        <p className="callout warn">Judge wallets are listed in the submission form, with their access instructions.</p>
      ) : (
        <ul className="judge-wallets">
          {wallets.map((w) => (
            <li key={w.address}>
              <span className="judge-label">{w.label}</span>
              <span className="mono judge-addr">{w.address}</span>
              <CopyButton text={w.address} label={`${w.label} address`} />
            </li>
          ))}
        </ul>
      )}
      <div className="judge-warn" role="note">
        <strong>Testnet-only. Never put real funds here.</strong> Private keys for these testnet-only wallets are in the submission form&rsquo;s access instructions. Do not import them into a wallet that holds real assets, and do not send anything of value to these addresses.
      </div>
      <p className="sub">The fast-demo series (five-minute lifecycle) is already fully redeemed, so use the live series to mint, trade and redeem. Its settlement is on the Evidence page.</p>
    </div>
  );
}

export function JudgeAccess() {
  return (
    <JudgeAccessView
      wallets={parseJudgeWallets(judgeAccess)}
      network={{ name: chain.name, id: chain.id, rpcUrl: config.chain.rpcUrl, symbol: config.chain.nativeSymbol }}
    />
  );
}
