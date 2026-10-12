import { defineChain, isAddress, type Address, type Chain } from "viem";
import local from "./local.json";
import monadTestnet from "./monad-testnet.json";
import type {
  ContractAddresses,
  DeployedContract,
  DeploymentManifest,
  NetworkConfig,
  NetworkName,
  NetworkSettings,
} from "./types";

const settings: Record<NetworkName, NetworkSettings> = {
  "monad-testnet": monadTestnet as NetworkSettings,
  local: local as NetworkSettings,
};

// deployments/<network>.json is written by scripts/deploy.ts. A glob import tolerates files that do not exist yet.
const manifests = import.meta.glob<DeploymentManifest>("../../../deployments/*.json", {
  eager: true,
  import: "default",
});

function manifestFor(network: NetworkName, chainId: number): DeploymentManifest | null {
  const entry = Object.entries(manifests).find(([path]) => path.endsWith(`/${network}.json`));
  const manifest = entry?.[1];
  return manifest && manifest.status === "complete" && manifest.chainId === chainId ? manifest : null;
}

function pickNetwork(): NetworkName {
  const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("network");
  const requested = fromUrl ?? (import.meta.env.VITE_NETWORK as string | undefined) ?? "monad-testnet";
  return requested in settings ? (requested as NetworkName) : "monad-testnet";
}

function resolve(network: NetworkName): NetworkConfig {
  const base = settings[network];
  const rpcOverride = import.meta.env.VITE_RPC_URL as string | undefined;
  const manifest = manifestFor(network, base.chain.id);

  const deployed: Record<string, DeployedContract> = {};
  for (const [key, entry] of Object.entries(manifest?.contracts ?? {})) {
    if (!entry.address) continue;
    if (!isAddress(entry.address)) throw new Error(`Invalid address for ${key} in deployments/${network}.json`);
    deployed[key] = {
      address: entry.address,
      txHash: entry.txHash ?? null,
      blockNumber: entry.blockNumber === undefined ? null : Number(entry.blockNumber),
      mock: entry.mock === true,
    };
  }
  const at = (key: string): Address | null => deployed[key]?.address ?? null;
  const contracts: ContractAddresses = {
    market: at("market"),
    longClaim: at("longClaim"),
    shortClaim: at("shortClaim"),
    collateral: at("collateral"),
    receiver: at("settlementReceiver"),
    markFeed: at("markFeed"),
    forwarder: at("forwarder"),
  };
  const blocks = Object.values(deployed).map((c) => c.blockNumber).filter((n): n is number => n !== null && Number.isFinite(n));

  // Development only: preview the Trade step against an existing Kuru market (for example on a local fork).
  const kuruOverride = import.meta.env.VITE_KURU_LONG_MARKET as string | undefined;
  if (kuruOverride) base.kuru = { ...base.kuru, longMarket: kuruOverride as Address };

  for (const value of [base.kuru.longMarket, base.kuru.shortMarket, base.kuru.accountCore, base.kuru.quoteToken]) {
    if (value !== null && !isAddress(value)) throw new Error(`Invalid address in config/${network}.json: ${value}`);
  }

  return {
    ...base,
    chain: rpcOverride ? { ...base.chain, rpcUrl: rpcOverride } : base.chain,
    contracts,
    deployed,
    deployBlock: blocks.length ? Math.min(...blocks) : null,
    deployer: manifest?.deployer ?? null,
    settlementMode: manifest?.series?.mode ?? null,
  };
}

export const config: NetworkConfig = resolve(pickNetwork());

export const chain: Chain = defineChain({
  id: config.chain.id,
  name: config.chain.name,
  nativeCurrency: { name: config.chain.nativeSymbol, symbol: config.chain.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
  blockExplorers: config.chain.explorerUrl ? { default: { name: "Explorer", url: config.chain.explorerUrl } } : undefined,
  contracts: config.chain.multicall3 ? { multicall3: { address: config.chain.multicall3 } } : undefined,
  testnet: true,
});

export const explorer = {
  address: (a: Address) => (config.chain.explorerUrl ? `${config.chain.explorerUrl}/address/${a}` : null),
  tx: (h: string) => (config.chain.explorerUrl ? `${config.chain.explorerUrl}/tx/${h}` : null),
  block: (n: bigint | number) => (config.chain.explorerUrl ? `${config.chain.explorerUrl}/block/${n}` : null),
};
