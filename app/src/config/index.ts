import { defineChain, isAddress, type Address, type Chain } from "viem";
import local from "./local.json";
import monadTestnet from "./monad-testnet.json";
import { manifestFrom } from "./deployment";
import type {
  ContractAddresses,
  DeployedContract,
  DeploymentManifest,
  NetworkConfig,
  NetworkName,
  NetworkSettings,
  PublicManifest,
  SeriesChoice,
  SeriesSubject,
} from "./types";

const settings: Record<NetworkName, NetworkSettings> = {
  "monad-testnet": monadTestnet as NetworkSettings,
  local: local as NetworkSettings,
};

// deployments/<network>.json is written by scripts/deploy.ts and is not tracked; a clean clone falls back to the
// tracked deployments/<network>.public.json. A glob import tolerates files that do not exist yet.
const manifests = import.meta.glob<DeploymentManifest>("../../../deployments/*.json", {
  eager: true,
  import: "default",
});

const publicManifests = Object.entries(manifests).filter(([path]) => path.endsWith(".public.json"));

function manifestFor(network: NetworkName, chainId: number, variant: string | null): DeploymentManifest | null {
  const pub = publicManifests.find(([path]) => path.endsWith(`/${network}.public.json`))?.[1] as unknown as PublicManifest | undefined;
  return manifestFrom(manifests, pub, network, chainId, variant);
}

function pickNetwork(): NetworkName {
  const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("network");
  const requested = fromUrl ?? (import.meta.env.VITE_NETWORK as string | undefined) ?? "monad-testnet";
  return requested in settings ? (requested as NetworkName) : "monad-testnet";
}

function pickVariant(network: NetworkName): string | null {
  const known = settings[network].variants ?? {};
  const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("series");
  const requested = fromUrl ?? (import.meta.env.VITE_SERIES as string | undefined) ?? null;
  return requested !== null && requested in known && manifestFor(network, settings[network].chain.id, requested) !== null ? requested : null;
}

interface Deployment {
  contracts: ContractAddresses;
  deployed: Record<string, DeployedContract>;
  deployBlock: number | null;
  deployer: Address | null;
  settlementMode: "simulation" | "strict" | null;
}

function deploymentFor(network: NetworkName, chainId: number, variant: string | null): Deployment {
  const manifest = manifestFor(network, chainId, variant);
  const deployed: Record<string, DeployedContract> = {};
  for (const [key, entry] of Object.entries(manifest?.contracts ?? {})) {
    if (!entry.address) continue;
    if (!isAddress(entry.address)) throw new Error(`Invalid address for ${key} in the ${network} deployment manifest`);
    deployed[key] = {
      address: entry.address,
      txHash: entry.txHash ?? null,
      blockNumber: entry.blockNumber === undefined ? null : Number(entry.blockNumber),
      mock: entry.mock === true,
    };
  }
  const at = (key: string): Address | null => deployed[key]?.address ?? null;
  const blocks = Object.values(deployed).map((c) => c.blockNumber).filter((n): n is number => n !== null && Number.isFinite(n));
  return {
    contracts: {
      market: at("market"),
      longClaim: at("longClaim"),
      shortClaim: at("shortClaim"),
      collateral: at("collateral"),
      receiver: at("settlementReceiver"),
      markFeed: at("markFeed"),
      shortFeed: at("shortFeed"),
      forwarder: at("forwarder"),
    },
    deployed,
    deployBlock: blocks.length ? Math.min(...blocks) : null,
    deployer: manifest?.deployer ?? null,
    settlementMode: manifest?.series?.mode ?? null,
  };
}

function resolve(network: NetworkName): NetworkConfig {
  const variant = pickVariant(network);
  const chosen = variant ? settings[network].variants?.[variant] : undefined;
  const base: NetworkSettings = chosen ? { ...settings[network], series: chosen.series, evidenceBase: chosen.evidenceBase } : settings[network];
  const rpcOverride = import.meta.env.VITE_RPC_URL as string | undefined;
  const logsOverride = import.meta.env.VITE_LOGS_RPC_URL as string | undefined;
  const chainId = base.chain.id;
  const deployment = deploymentFor(network, chainId, variant);

  const seriesChoices: SeriesChoice[] = [{ id: null, label: "Live series", blurb: "The series that settles during judging." }];
  const subjects: SeriesSubject[] = [];
  for (const [id, v] of Object.entries(settings[network].variants ?? {})) {
    if (manifestFor(network, chainId, id) === null) continue;
    seriesChoices.push({ id, label: v.label, blurb: v.blurb });
    subjects.push({ id, label: v.label, evidenceTitle: v.evidenceTitle, series: v.series, evidenceBase: v.evidenceBase, ...deploymentFor(network, chainId, id) });
  }
  subjects.push({
    id: null,
    label: "Live series",
    evidenceTitle: settings[network].evidenceTitle,
    series: settings[network].series,
    evidenceBase: settings[network].evidenceBase,
    ...deploymentFor(network, chainId, null),
  });

  // Development only: preview the Trade step against an existing Kuru market (for example on a local fork).
  const kuruOverride = import.meta.env.VITE_KURU_LONG_MARKET as string | undefined;
  if (kuruOverride) base.kuru = { ...base.kuru, longMarket: kuruOverride as Address };
  const kuruShortOverride = import.meta.env.VITE_KURU_SHORT_MARKET as string | undefined;
  if (kuruShortOverride) base.kuru = { ...base.kuru, shortMarket: kuruShortOverride as Address };

  for (const value of [base.kuru.longMarket, base.kuru.shortMarket, base.kuru.accountCore, base.kuru.quoteToken]) {
    if (value !== null && !isAddress(value)) throw new Error(`Invalid address in config/${network}.json: ${value}`);
  }

  return {
    ...base,
    variant,
    subjects,
    seriesChoices,
    chain: {
      ...base.chain,
      rpcUrl: rpcOverride ?? base.chain.rpcUrl,
      logsRpcUrl: logsOverride ?? base.chain.logsRpcUrl,
    },
    ...deployment,
  };
}

export const config: NetworkConfig = resolve(pickNetwork());

// The series every step other than the evidence step is about: the live one unless ?series= picks another.
export const primarySubject: SeriesSubject =
  config.subjects.find((s) => s.id === config.variant) ?? (config.subjects[config.subjects.length - 1] as SeriesSubject);

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
