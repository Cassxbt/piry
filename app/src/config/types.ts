import type { Address, Hex } from "viem";

export type NetworkName = "monad-testnet" | "local";

export interface ContractAddresses {
  market: Address | null;
  longClaim: Address | null;
  shortClaim: Address | null;
  collateral: Address | null;
  receiver: Address | null;
  markFeed: Address | null;
  shortFeed: Address | null;
  forwarder: Address | null;
}

// One public source behind a composite index. Values are what the operator has recorded; the chain remains the
// authority for the settled index price.
export interface IndexComponent {
  name: string;
  detail: string | null;
  value: string | null;
  status: "pending" | "valid" | "failed";
  url: string | null;
  rule: string | null;
  why: string | null;
}

// A published reference series shown beside the settlement index. It never feeds settlement.
export interface SanityBand {
  name: string;
  license: string;
  note: string;
  url: string | null;
  value: string | null;
  asOf: string | null;
}

export interface DeployedContract {
  address: Address;
  txHash: Hex | null;
  blockNumber: number | null;
  mock: boolean;
}

export interface SeriesSettings {
  name: string;
  hardware: string;
  units: string;
  dataMode: "DEMO" | "LIVE";
  source: {
    name: string;
    summary: string;
    demo: string | null;
    minValid: number | null;
    bounds: { min: string; max: string } | null;
    components: IndexComponent[];
    componentsAsOf: string | null;
    sanityBand: SanityBand | null;
  };
}

// A second deployment on the same network, selected with ?series=<id> and read from deployments/<network>.<id>.json.
export interface SeriesVariant {
  label: string;
  evidenceTitle: string;
  blurb: string;
  series: SeriesSettings;
  evidenceBase: string;
}

// Shape of src/config/<network>.json: everything except what a deployment determines.
export interface NetworkSettings {
  network: NetworkName;
  chain: {
    id: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string | null;
    nativeSymbol: string;
    blockTimeMs: number | null;
    getLogsMaxRange: number;
    logsRpcUrl: string | null;
    logsRpcLabel: string | null;
    logsRpcUpstream: string | null;
    logsMaxRange: number;
    logsRequestsPerSecond: number;
    scanMaxRequests: number;
    requestsPerSecond: number;
    multicall3: Address | null;
  };
  settlement: { source: string; markCadence: string | null };
  series: SeriesSettings;
  collateralHelp: { kuruToken: string; deployerToken: string };
  evidenceTitle: string;
  kuru: {
    accountCore: Address;
    quoteToken: Address;
    quoteSymbol: string;
    quoteDecimals: number;
    longMarket: Address | null;
    shortMarket: Address | null;
  };
  evidenceBase: string;
  markStaleSeconds: number;
  // PiryFaucet: drips test quote token once per address. Absent where there is no faucet.
  faucet?: Address;
  // Wallets that count as team test activity on the traction panel; every other wallet is unclassified, which does
  // not mean independent.
  teamAddresses?: Address[];
  teamAddressesAsOf?: string;
  // First block to scan for trades and pair events: the ComputeMarket's deployment block.
  tractionFromBlock?: number;
  variants?: Record<string, SeriesVariant>;
}

// Subset of deployments/<network>.json (written by scripts/deploy.ts) that the app reads.
export interface DeploymentManifest {
  network: string;
  chainId: number;
  status: string;
  deployer?: Address;
  series?: { mode?: "simulation" | "strict" };
  contracts?: Record<string, { address?: Address; txHash?: Hex; blockNumber?: string; mock?: boolean }>;
}

// deployments/<network>.public.json: the tracked, secret-free record of the same deployments. The app builds from it
// when the ignored local manifests are absent, as in a clean clone.
export interface PublicContract {
  address: Address;
  deployTx?: Hex;
  block?: string | number;
}

export interface PublicSeries {
  settlementMode?: "simulation" | "strict";
  contracts: Record<string, PublicContract>;
}

export interface PublicManifest {
  network: string;
  chainId: number;
  deployer?: Address;
  creMockForwarder?: Address;
  liveSeries: PublicSeries;
  fastDemoSeries?: PublicSeries;
  kuru: { accountCore: Address; markets: Record<string, { address: Address; block?: number }> };
  faucet: { address: Address };
}

// One deployed series as the evidence step sees it. The page shows several at once, so nothing in the evidence
// code reads the active series from global config.
export interface SeriesSubject {
  id: string | null;
  label: string;
  evidenceTitle: string;
  series: SeriesSettings;
  evidenceBase: string;
  contracts: ContractAddresses;
  deployed: Record<string, DeployedContract>;
  deployBlock: number | null;
  settlementMode: "simulation" | "strict" | null;
}

export interface SeriesChoice {
  id: string | null;
  label: string;
  blurb: string;
}

export interface NetworkConfig extends NetworkSettings {
  variant: string | null;
  subjects: SeriesSubject[];
  seriesChoices: SeriesChoice[];
  contracts: ContractAddresses;
  deployed: Record<string, DeployedContract>;
  deployBlock: number | null;
  deployer: Address | null;
  settlementMode: "simulation" | "strict" | null;
}
