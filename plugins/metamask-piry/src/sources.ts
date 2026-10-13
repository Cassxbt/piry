import { fmt } from "./math.js";

// The same four public H100 SXM, 1-GPU, on-demand sources and selection rules as the Piry composite index
// (workflow/composite.ts), read directly so an agent can see the number before the next on-chain mark.
export const SOURCE_NAMES = ["akash", "runpod", "verda", "shadeform"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

const URLS: Record<SourceName, string> = {
  akash: "https://console-api.akash.network/v1/gpu-prices",
  runpod: "https://api.runpod.io/graphql",
  verda: "https://api.verda.com/v1/instance-types",
  shadeform: "https://api.shadeform.ai/v1/instances/types?gpu_type=H100&num_gpus=1",
};

const RUNPOD_QUERY = '{ gpuTypes(input:{id:"NVIDIA H100 80GB HBM3"}) { id lowestPrice(input:{gpuCount:1}){ uninterruptablePrice } } }';
const MIN_SOURCES = 3;
const SANITY_MIN = 500_000n;
const SANITY_MAX = 20_000_000n;
const MAX_BYTES = 1_000_000;
const DECIMALS = 6;

export interface Reading {
  source: SourceName;
  ok: boolean;
  usd?: string;
  reason?: string;
}

export interface Composite {
  indexUsd: string | null;
  validSources: number;
  required: number;
  readings: Reading[];
}

type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("unexpected response shape");
  return v as Record<string, unknown>;
};

// Decimal text to micro-USD without floating-point multiplication. Digits past 6 decimals are floored, as in the
// workflow's decimalUnits, so the index shown here cannot differ from the one the workflow publishes.
export function toMicro(value: unknown): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,8})(\.\d+)?$/.test(text)) throw new Error("price is not a plain positive decimal");
  const [whole = "0", fraction = ""] = text.split(".");
  const micro = BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0").slice(0, DECIMALS));
  if (micro === 0n) throw new Error("price is zero");
  return micro;
}

export const median = (values: bigint[]): bigint => {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
};

export function extractAkash(body: unknown): bigint {
  const models = obj(body).models;
  if (!Array.isArray(models)) throw new Error("models missing");
  const hits = models.filter((m) => { const o = obj(m); return o.vendor === "nvidia" && o.model === "h100" && o.ram === "80Gi" && o.interface === "SXM5"; });
  if (hits.length !== 1) throw new Error(`expected one H100 SXM5 model, found ${hits.length}`);
  const model = obj(hits[0]);
  const price = obj(model.price);
  const providers = obj(model.providerAvailability).total;
  if (price.currency !== "USD") throw new Error("currency is not USD");
  if (typeof providers !== "number" || providers < 2) throw new Error("fewer than 2 providers");
  return toMicro(price.weightedAverage);
}

export function extractRunpod(body: unknown): bigint {
  const types = obj(obj(body).data).gpuTypes;
  if (!Array.isArray(types)) throw new Error("gpuTypes missing");
  const hits = types.filter((t) => obj(t).id === "NVIDIA H100 80GB HBM3");
  if (hits.length !== 1) throw new Error(`expected one gpu type, found ${hits.length}`);
  return toMicro(obj(obj(hits[0]).lowestPrice).uninterruptablePrice);
}

export function extractVerda(body: unknown): bigint {
  if (!Array.isArray(body)) throw new Error("instance types missing");
  const hits = body.filter((t) => { const o = obj(t); const gpu = o.gpu === undefined ? {} : obj(o.gpu); return gpu.description === "1x H100 SXM5 80GB" && gpu.number_of_gpus === 1; });
  if (hits.length === 0) throw new Error("no matching instance type");
  const prices = hits.map((t) => { const o = obj(t); if (o.currency !== "usd") throw new Error("currency is not usd"); return toMicro(o.price_per_hour); });
  return prices.reduce((min, p) => (p < min ? p : min));
}

export function extractShadeform(body: unknown): bigint {
  const listings = obj(body).instance_types;
  if (!Array.isArray(listings)) throw new Error("instance_types missing");
  const cheapest = new Map<string, number>();
  for (const l of listings) {
    const o = obj(l);
    const c = o.configuration === undefined ? {} : obj(o.configuration);
    if (c.gpu_type !== "H100" || c.num_gpus !== 1 || c.interconnect !== "sxm5") continue;
    if (typeof o.cloud !== "string" || o.cloud === "verda") continue;
    const cents = o.hourly_price;
    if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) throw new Error("hourly_price is not positive integer cents");
    cheapest.set(o.cloud, Math.min(cheapest.get(o.cloud) ?? cents, cents));
  }
  if (cheapest.size < 4) throw new Error(`${cheapest.size} clouds listed, 4 required`);
  return median([...cheapest.values()].map((cents) => BigInt(cents) * 10n ** BigInt(DECIMALS) / 100n));
}

const EXTRACT: Record<SourceName, (body: unknown) => bigint> = { akash: extractAkash, runpod: extractRunpod, verda: extractVerda, shadeform: extractShadeform };

async function readSource(source: SourceName, fetcher: Fetcher): Promise<Reading> {
  try {
    const post = source === "runpod";
    const res = await fetcher(URLS[source], {
      method: post ? "POST" : "GET",
      headers: post ? { "content-type": "application/json" } : { accept: "application/json" },
      body: post ? JSON.stringify({ query: RUNPOD_QUERY }) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("response too large");
    const micro = EXTRACT[source](JSON.parse(text));
    if (micro < SANITY_MIN || micro > SANITY_MAX) throw new Error("outside the 0.50 to 20.00 sanity bounds");
    return { source, ok: true, usd: fmt(micro, DECIMALS) };
  } catch (error) {
    return { source, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchComposite(fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Composite> {
  const readings = await Promise.all(SOURCE_NAMES.map((s) => readSource(s, fetcher)));
  const good = readings.filter((r) => r.ok && r.usd !== undefined).map((r) => toMicro(r.usd));
  return {
    indexUsd: good.length >= MIN_SOURCES ? fmt(median(good), DECIMALS) : null,
    validSources: good.length,
    required: MIN_SOURCES,
    readings,
  };
}
