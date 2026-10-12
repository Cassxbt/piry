import type { WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { chain } from "../config";

export function useWallet(): WalletClient | undefined {
  const { data } = useWalletClient({ chainId: chain.id });
  return data as WalletClient | undefined;
}
