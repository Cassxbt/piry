import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { piryFaucetAbi } from "../abi";
import { config } from "../config";
import { useClient } from "./chain";

const POLL_MS = 15_000;

export function useQuoteBalance(account: Address | undefined) {
  const pc = useClient();
  return useQuery({
    queryKey: ["quote-balance", account],
    queryFn: () => pc.readContract({ address: config.kuru.quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [account as Address] }),
    enabled: account !== undefined,
    refetchInterval: POLL_MS,
  });
}

export function useFaucet(account: Address | undefined) {
  const pc = useClient();
  const faucet = config.faucet;
  return useQuery({
    queryKey: ["faucet", faucet, account],
    enabled: faucet !== undefined,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const address = faucet as Address;
      const [amount, balance, claimed] = await Promise.all([
        pc.readContract({ address, abi: piryFaucetAbi, functionName: "amount" }),
        pc.readContract({ address: config.kuru.quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        account ? pc.readContract({ address, abi: piryFaucetAbi, functionName: "claimed", args: [account] }) : Promise.resolve(undefined),
      ]);
      return { amount, balance, claimed };
    },
  });
}

export interface WalletBalances {
  mon: bigint;
  usdc: bigint;
}

export function useWalletBalances(addresses: Address[]) {
  const pc = useClient();
  return useQuery({
    queryKey: ["wallet-balances", addresses],
    enabled: addresses.length > 0,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const rows = await Promise.all(
        addresses.map(async (a) => {
          const [mon, usdc] = await Promise.all([
            pc.getBalance({ address: a }),
            pc.readContract({ address: config.kuru.quoteToken, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
          ]);
          return [a, { mon, usdc }] as const;
        }),
      );
      return Object.fromEntries(rows) as Record<Address, WalletBalances>;
    },
  });
}
