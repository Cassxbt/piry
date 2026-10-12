import type { Address, Hex } from "viem";

export type NetworkName = "monad-testnet" | "local";

export interface ContractAddresses {
  market: Address | null;
  longClaim: Address | null;
  shortClaim: Address | null;
  collateral: Address | null;
  receiver: Address | null;
  markFeed: Address | null;
  forwarder: Address | null;
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

// Shape of src/config/<network>.json: everything except what a deployment determines.
export interface NetworkSettings {
  network: NetworkName;
  chain: {
    id: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string | null;
    nativeSymbol: string;
    getLogsMaxRange: number;
    scanMaxRequests: number;
    requestsPerSecond: number;
    multicall3: Address | null;
  };
  settlement: { source: string };
  series: {
    name: string;
    hardware: string;
    units: string;
    dataMode: "DEMO" | "LIVE";
    source: {
      name: string;
      summary: string;
      demo: string | null;
      sanityBand: SanityBand | null;
    };
  };
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

export interface NetworkConfig extends NetworkSettings {
  contracts: ContractAddresses;
  deployed: Record<string, DeployedContract>;
  deployBlock: number | null;
  deployer: Address | null;
  settlementMode: "simulation" | "strict" | null;
}
