import { createPublicClient, http, type PublicClient } from "viem";
import { chain, config } from "../config";
import { rateLimitedFetch } from "./rateLimit";

// A second RPC used only to scan event logs. The primary RPC stays the source for ordinary reads; this one accepts
// much wider getLogs ranges. When it errors, callers fall back to the primary with its smaller pages.
const absolute = (url: string) => (url.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${url}` : url);

export const logsClient: PublicClient | null = config.chain.logsRpcUrl
  ? (createPublicClient({
      chain,
      transport: http(absolute(config.chain.logsRpcUrl), { batch: true, retryCount: 0, fetchFn: rateLimitedFetch(config.chain.logsRequestsPerSecond) }),
    }) as PublicClient)
  : null;

// Once the logs RPC has failed in this session (CORS, outage, rate limit) it is skipped, so each later query goes
// straight to the primary RPC instead of waiting on a provider that is known to be unreachable.
let logsRpcBroken = false;

export interface LogSource {
  client: PublicClient;
  maxRange: number;
  name: string;
}

export const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || url;

// Preferred first, with the primary RPC as the fallback.
export function logSources(primary: PublicClient): LogSource[] {
  const sources: LogSource[] = [];
  if (logsClient && config.chain.logsRpcUrl && !logsRpcBroken) {
    sources.push({ client: logsClient, maxRange: config.chain.logsMaxRange, name: config.chain.logsRpcLabel ?? hostOf(config.chain.logsRpcUrl) });
  }
  sources.push({ client: primary, maxRange: config.chain.getLogsMaxRange, name: hostOf(config.chain.rpcUrl) });
  return sources;
}

// Runs a scan against each source in turn and returns the first that succeeds, noting any that failed before it.
export async function withLogFallback<T>(
  sources: LogSource[],
  run: (source: LogSource) => Promise<T>,
): Promise<{ result: T; source: LogSource; failed: string[] }> {
  const failed: string[] = [];
  let last: unknown;
  for (const source of sources) {
    try {
      return { result: await run(source), source, failed };
    } catch (error) {
      last = error;
      failed.push(source.name);
      if (source.client === logsClient) logsRpcBroken = true;
    }
  }
  throw last instanceof Error ? last : new Error("every log source failed");
}
