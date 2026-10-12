import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { config } from "../config";
import { readKuruAccount, readKuruBook, readOpenOrders } from "../lib/kuru";
import { useClient } from "./chain";

export type KuruSide = "long" | "short";

export const kuruMarketFor = (side: KuruSide): Address | null => (side === "long" ? config.kuru.longMarket : config.kuru.shortMarket);

export function useKuruBook(side: KuruSide) {
  const pc = useClient();
  const market = kuruMarketFor(side);
  return useQuery({
    queryKey: ["kuru-book", market],
    queryFn: () => readKuruBook(pc, market as Address),
    enabled: market !== null,
    refetchInterval: 6_000,
    retry: 1,
  });
}

export function useKuruAccount(owner: Address | undefined, tokens: Address[]) {
  const pc = useClient();
  return useQuery({
    queryKey: ["kuru-account", owner, tokens],
    queryFn: () => readKuruAccount(pc, config.kuru.accountCore, owner as Address, tokens),
    enabled: owner !== undefined && tokens.length > 0 && (config.kuru.longMarket !== null || config.kuru.shortMarket !== null),
    refetchInterval: 8_000,
    retry: 1,
  });
}

export function useOpenOrders(side: KuruSide, rootId: bigint | undefined) {
  const pc = useClient();
  const market = kuruMarketFor(side);
  return useQuery({
    queryKey: ["kuru-orders", market, rootId?.toString()],
    queryFn: () => readOpenOrders(pc, market as Address, rootId as bigint, config.kuru.accountCore),
    enabled: market !== null && rootId !== undefined && rootId > 0n,
    refetchInterval: 8_000,
    retry: 1,
  });
}

export function useWalletTokens(owner: Address | undefined, tokens: Address[]) {
  const pc = useClient();
  return useQuery({
    queryKey: ["wallet-tokens", owner, tokens],
    queryFn: async () => {
      const balances = await Promise.all(
        tokens.map((token) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] })),
      );
      return Object.fromEntries(tokens.map((t, i) => [t.toLowerCase(), balances[i] ?? 0n])) as Record<string, bigint>;
    },
    enabled: owner !== undefined && tokens.length > 0,
    refetchInterval: 8_000,
  });
}
