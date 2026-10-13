import { getAddress, isAddress, type Address, type Hex } from "viem";
import { CHAIN_ID } from "./config.js";
import { PiryError } from "./errors.js";
import type { Intent, TxReceipt, TxRequest, Wallet } from "./tx.js";

interface WalletInfo {
  id?: string;
  address: string;
  name?: string;
  namespace?: string;
}

export interface WalletSnapshot {
  byokWallets: readonly WalletInfo[];
  remoteWallets: readonly WalletInfo[];
  selectedWallet?: { ref?: { id?: string; address?: string; name?: string } };
}

// The wallet the executor signs with is the host's selected EVM wallet; resolve the same one for balance reads.
export function activeAddress(state: WalletSnapshot): Address {
  const wallets = [...state.byokWallets, ...state.remoteWallets].filter((w) => (w.namespace ?? "evm") === "evm" && isAddress(w.address));
  const ref = state.selectedWallet?.ref;
  let wallet: WalletInfo | undefined;
  if (ref) {
    // Each field the host names must agree wherever the wallet carries it, and at least one must be comparable:
    // a partial match could be a different wallet than the one that signs.
    const verdicts = (w: WalletInfo) => [
      ref.id === undefined || w.id === undefined ? null : w.id === ref.id,
      ref.address === undefined ? null : w.address.toLowerCase() === ref.address.toLowerCase(),
      ref.name === undefined || w.name === undefined ? null : w.name === ref.name,
    ].filter((v) => v !== null);
    const matches = wallets.filter((w) => { const v = verdicts(w); return v.length > 0 && v.every(Boolean); });
    if (matches.length !== 1) {
      throw new PiryError("WALLET_NOT_RESOLVED", `The selected wallet (${[ref.name, ref.address, ref.id].find((v) => v !== undefined) ?? "unnamed"}) ${matches.length === 0 ? "is not an EVM wallet this plugin can see" : "matches more than one wallet"}.`, "Run `mm wallet list` and select an EVM wallet, then retry. Nothing was sent.");
    }
    wallet = matches[0];
  } else if (wallets.length === 1) {
    wallet = wallets[0];
  } else if (wallets.length > 1) {
    throw new PiryError("WALLET_NOT_RESOLVED", "No wallet is selected and several EVM wallets exist, so the signing wallet is ambiguous.", "Select a wallet in the Agent Wallet, then retry. Nothing was sent.");
  }
  if (!wallet) throw new PiryError("NO_WALLET", "No EVM wallet is available in the Agent Wallet.", "Run `mm login` and `mm init`, then check `mm wallet address`.");
  return getAddress(wallet.address);
}

// Shape of the host's wallet executor (ctx.walletExecutor) as far as this plugin uses it.
export type HostExecutor = (
  request: { kind: "transaction"; chainId: number; transaction: { to: Address; data: Hex; value?: bigint }; intent: Intent },
  options: { signal?: AbortSignal; waitForReceipt: boolean },
) => Promise<{ hash: string; status: string }>;

// waitForReceipt makes the host confirm each step is mined before the next one is built on it.
export function adaptExecutor(address: Address, execute: HostExecutor, signal?: AbortSignal): Wallet {
  return {
    address,
    send: async (tx: TxRequest, intent: Intent): Promise<TxReceipt> => {
      const result = await execute(
        { kind: "transaction", chainId: CHAIN_ID, transaction: { to: tx.to, data: tx.data, ...(tx.value === undefined ? {} : { value: tx.value }) }, intent },
        { signal, waitForReceipt: true },
      );
      return { hash: result.hash as Hex, status: result.status };
    },
  };
}
