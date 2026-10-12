import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { chain } from "../config";
import { shortAddress } from "../lib/format";

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (!isConnected || !address) {
    const hasWallet = typeof window !== "undefined" && "ethereum" in window;
    return (
      <button
        type="button"
        className="btn secondary small wallet-btn"
        disabled={isPending}
        onClick={() => connectors[0] && connect({ connector: connectors[0] })}
        title={error?.message ?? (hasWallet ? "Connect an injected wallet" : "No injected wallet found in this browser")}
      >
        {isPending ? "Connecting" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== chain.id) {
    return (
      <button type="button" className="btn small wallet-btn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  }

  return (
    <button type="button" className="btn secondary small wallet-btn mono" onClick={() => disconnect()} title="Disconnect">
      {shortAddress(address)}
    </button>
  );
}
