import { createPublicClient, defineChain, http } from "viem";
import type { Reader } from "./chain.js";
import { CHAIN_ID, DEFAULT_RPC_URL } from "./config.js";

// The public Monad RPC allows 15 requests per second, so concurrent reads are folded into Multicall3 calls.
const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export function makeReader(rpcUrl: string): Reader {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl, { retryCount: 4, retryDelay: 400, timeout: 15_000 }),
    batch: { multicall: { wait: 20 } },
  });
}
