import { EVMClient, encodeCallMsg, type Runtime } from "@chainlink/cre-sdk";
import { bytesToHex, decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Abi, type Address } from "viem";
import type { Config } from "./config.js";
import { indexIdentity, requireValue } from "./validation.js";

export const MARKET_ABI = parseAbi([
  "function indexId() view returns (bytes32)",
  "function specHash() view returns (bytes32)",
  "function priceDecimals() view returns (uint8)",
  "function periodStart() view returns (uint64)",
  "function periodEnd() view returns (uint64)",
  "function settlementAuthority() view returns (address)",
  "function settled() view returns (bool)",
]);

export const FEED_ABI = parseAbi([
  "function market() view returns (address)",
  "function indexId() view returns (bytes32)",
]);

function read(runtime: Runtime<Config>, config: Config, to: string, abi: Abi, functionName: string): unknown {
  const reply = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chainName]).callContract(runtime, {
    call: encodeCallMsg({ from: zeroAddress, to: to as Address, data: encodeFunctionData({ abi, functionName }) }),
  }).result();
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(reply.data) });
}

// Read-only check, run before any source fetch, that the configured series is the one deployed at the configured
// addresses. A mark carries neither specHash nor price scale, so only this check binds it to the market's terms. The chain
// itself is selected by chainName (bound to chainId in the schema); a contract answering with this identity proves the right one.
export function preflight(runtime: Runtime<Config>, config: Config, feed?: string): void {
  const { terms } = config;
  const identity = indexIdentity(terms);
  const agree = (what: string, onChain: unknown, configured: unknown) => requireValue(
    String(onChain).toLowerCase() === String(configured).toLowerCase(), `preflight: ${what} is ${onChain} on chain, ${configured} configured`);
  const market = (name: string) => read(runtime, config, config.market, MARKET_ABI, name);
  agree("market indexId", market("indexId"), identity.indexId);
  agree("market specHash", market("specHash"), identity.specHash);
  agree("market priceDecimals", market("priceDecimals"), terms.priceDecimals);
  agree("market periodStart", market("periodStart"), terms.periodStart);
  agree("market periodEnd", market("periodEnd"), terms.periodEnd);
  requireValue(market("settled") === false, "preflight: market already settled");
  if (feed === undefined) return agree("market settlementAuthority", market("settlementAuthority"), config.receiver);
  agree("feed market", read(runtime, config, feed, FEED_ABI, "market"), config.market);
  agree("feed indexId", read(runtime, config, feed, FEED_ABI, "indexId"), identity.indexId);
}
