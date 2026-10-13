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
  const selected = ref
    ? wallets.find((w) => (ref.id !== undefined && w.id === ref.id) || (ref.address !== undefined && w.address.toLowerCase() === ref.address.toLowerCase()) || (ref.name !== undefined && w.name === ref.name))
    : undefined;
  const wallet = selected ?? wallets[0];
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
