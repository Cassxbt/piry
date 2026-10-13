import type { DeploymentManifest, PublicManifest, PublicSeries } from "./types";

const PUBLIC_KEYS: Record<string, string> = {
  simulationSettlementReceiver: "settlementReceiver",
  computeMarket: "market",
  piryMarkFeed: "markFeed",
  piryShortFeed: "shortFeed",
  "longClaimPIRY-L": "longClaim",
  "shortClaimPIRY-S": "shortClaim",
};

// The tracked public record names contracts per series; the app reads the shape scripts/deploy.ts writes.
function adapt(pub: PublicManifest, series: PublicSeries): DeploymentManifest {
  const contracts: NonNullable<DeploymentManifest["contracts"]> = {};
  if (pub.creMockForwarder) contracts.forwarder = { address: pub.creMockForwarder };
  for (const [name, c] of Object.entries(series.contracts)) {
    const key = name.startsWith("collateral") ? "collateral" : PUBLIC_KEYS[name];
    if (key) contracts[key] = { address: c.address, txHash: c.deployTx, blockNumber: c.block === undefined ? undefined : String(c.block) };
  }
  return { network: pub.network, chainId: pub.chainId, status: "complete", deployer: pub.deployer, series: { mode: series.settlementMode }, contracts };
}

// A complete local manifest wins; otherwise the tracked public record stands in for it.
export function manifestFrom(
  local: Record<string, DeploymentManifest>,
  pub: PublicManifest | undefined,
  network: string,
  chainId: number,
  variant: string | null,
): DeploymentManifest | null {
  const file = variant ? `${network}.${variant}.json` : `${network}.json`;
  const entry = Object.entries(local).find(([path]) => path.endsWith(`/${file}`));
  const manifest = entry?.[1];
  if (manifest && manifest.status === "complete" && manifest.chainId === chainId) return manifest;
  if (!pub || pub.network !== network || pub.chainId !== chainId) return null;
  const series = variant === null ? pub.liveSeries : variant === "fast-demo" ? pub.fastDemoSeries : undefined;
  return series ? adapt(pub, series) : null;
}
