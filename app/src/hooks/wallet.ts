import { useMemo } from "react";
import type { Account, Address, WalletClient } from "viem";
import { useConfig } from "wagmi";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";

export type ConnectedWallet = WalletClient & { account: Account };

export const CONNECT_FIRST = "Connect a wallet first";
export const CHANGED = "Wallet or series changed; nothing further was sent";
export const INPUTS_CHANGED = "Inputs changed; nothing further was sent";

export class StaleOperationError extends Error {
  constructor(message = CHANGED) {
    super(message);
    this.name = "StaleOperationError";
  }
}

export interface WalletPort {
  account(): { address: Address | undefined; chainId: number | undefined };
  switchChain(chainId: number): Promise<unknown>;
  walletClient(chainId: number, account: Address): Promise<WalletClient | undefined>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A connected account is enough to write: the chain switch and the wallet client are obtained on demand, because
// wagmi's useWalletClient is undefined while the wallet sits on another chain or its query has not settled.
// wagmi's injected connector falls back to wallet_addEthereumChain itself when the wallet does not know the chain.
export async function resolveWallet(port: WalletPort, chainId: number, owner?: Address, retryMs = 250): Promise<ConnectedWallet> {
  const live = port.account();
  if (!live.address) throw new Error(CONNECT_FIRST);
  if (owner && live.address.toLowerCase() !== owner.toLowerCase()) throw new StaleOperationError();
  if (live.chainId !== chainId) await port.switchChain(chainId);
  let failure: unknown = new Error("The wallet is not ready yet, try again");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(retryMs);
    try {
      const client = await port.walletClient(chainId, live.address);
      if (client?.account) return client as ConnectedWallet;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export function useWalletPort(): WalletPort {
  const wagmi = useConfig();
  return useMemo<WalletPort>(
    () => ({
      account: () => {
        const a = getAccount(wagmi);
        return { address: a.isConnected ? a.address : undefined, chainId: a.chainId };
      },
      switchChain: (chainId) => switchChain(wagmi, { chainId }),
      walletClient: (chainId, account) => getWalletClient(wagmi, { chainId, account }) as Promise<WalletClient>,
    }),
    [wagmi],
  );
}
