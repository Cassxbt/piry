import type { ReactNode } from "react";
import type { Hash } from "viem";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { chain, explorer } from "../config";
import type { ActionState } from "../hooks/action";
import { shortHash } from "../lib/format";

interface ButtonProps {
  label: string;
  onRun: () => void;
  busy: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "long" | "short";
  size?: "small" | "normal";
  block?: boolean;
}

// Gates a write behind wallet connection and the right network, so read-only visitors see why a button is inert.
export function ActionButton({ label, onRun, busy, disabled, variant = "primary", size = "normal", block }: ButtonProps) {
  const { isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();
  const cls = ["btn", variant === "primary" ? "" : variant, size === "small" ? "small" : "", block ? "block" : ""].filter(Boolean).join(" ");

  if (!isConnected) {
    return (
      <button type="button" className={`btn secondary ${size === "small" ? "small" : ""} ${block ? "block" : ""}`} disabled={isPending} onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
        Connect wallet to continue
      </button>
    );
  }
  if (chainId !== chain.id) {
    return (
      <button type="button" className={cls} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  }
  return (
    <button type="button" className={cls} disabled={busy || disabled} onClick={onRun}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      {busy ? "Working" : label}
    </button>
  );
}

function HashLink({ hash }: { hash: Hash }) {
  const href = explorer.tx(hash);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="mono">{shortHash(hash)}</a>
  ) : (
    <span className="mono" title={hash}>{shortHash(hash)}</span>
  );
}

export function TxStatus({ state }: { state: ActionState }): ReactNode {
  switch (state.phase) {
    case "idle":
      return null;
    case "wallet":
      return <p className="tx-status busy" role="status"><span className="spinner" aria-hidden />Confirm {state.label.toLowerCase()} in your wallet</p>;
    case "pending":
      return <p className="tx-status busy" role="status"><span className="spinner" aria-hidden />Waiting for confirmation <HashLink hash={state.hash} /></p>;
    case "done":
      return <p className="tx-status ok" role="status">{state.label} confirmed <HashLink hash={state.hash} /></p>;
    case "error":
      return <p className="tx-status bad" role="alert">{state.label} failed: {state.message}{state.hash ? <> <HashLink hash={state.hash} /></> : null}</p>;
  }
}
