import { fmt } from "./math.js";

// The same four public H100 SXM, 1-GPU, on-demand sources and selection rules as the Piry composite index
// (workflow/composite.ts), read directly so an agent can see the number before the next on-chain mark. This is a
// preview, not the accepted observation: the workflow's DON nodes reach consensus on their own fetches. The rules here
// (HTTP 200 only, byte caps, integer counts, cloud-name validation, decimal acceptance) are held to the workflow's by
// test/parity.test.ts, which feeds both the same bodies.
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
const MAX_BYTES: Record<SourceName, number> = { akash: 65_536, runpod: 65_536, shadeform: 65_536, verda: 200_000 };
const CLOUD = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VERDA_PRICE = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/;
const DECIMALS = 6;

export interface SourceRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  maxBytes: number;
}

export function sourceRequest(source: SourceName): SourceRequest {
  const post = source === "runpod";
  return {
    url: URLS[source],
    method: post ? "POST" : "GET",
    headers: post ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
    body: post ? JSON.stringify({ query: RUNPOD_QUERY }) : undefined,
    maxBytes: MAX_BYTES[source],
  };
}

export interface Reading {
  source: SourceName;
  ok: boolean;
  usd?: string;
  reason?: string;
}

export interface Composite {
  kind: "PREVIEW";
  note: string;
  indexUsd: string | null;
  validSources: number;
  required: number;
  readings: Reading[];
}

type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, name = "response"): Record<string, unknown> => {
  if (!isObject(v)) throw new Error(`invalid ${name}`);
  return v;
};

// workflow/validation.ts decimalUnits: a plain or exponent decimal string to micro-USD, no floating-point
// multiplication, digits past the scale floored.
export function decimalMicro(text: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/.exec(text);
  if (match === null) throw new Error("invalid decimal");
  const [, whole = "0", fraction = "", exponent = "0"] = match;
  const shift = Number(exponent) + DECIMALS - fraction.length;
  const digits = BigInt(whole + fraction);
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

// workflow/akash.ts numberToUnits: a JSON number, never a string.
export function numberToMicro(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("price must be a finite positive number");
  return decimalMicro(String(value));
}

export const median = (values: bigint[]): bigint => {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
};

// Like the workflow, entries that do not match the rule are skipped whatever their shape; only matching entries must
// be well formed.
export function extractAkash(body: unknown): bigint {
  const models = obj(body).models;
  if (!Array.isArray(models)) throw new Error("models missing");
  const hits = models.filter((m) => isObject(m) && m.vendor === "nvidia" && m.model === "h100" && m.ram === "80Gi" && m.interface === "SXM5");
  if (hits.length !== 1) throw new Error(`expected one H100 SXM5 model, found ${hits.length}`);
  const model = obj(hits[0], "model record");
  const price = obj(model.price, "price object");
  const providers = obj(model.providerAvailability, "provider availability").total;
  if (price.currency !== "USD") throw new Error("currency is not USD");
  if (typeof providers !== "number" || !Number.isSafeInteger(providers) || providers < 2) throw new Error("provider count below the minimum");
  return numberToMicro(price.weightedAverage);
}

export function extractRunpod(body: unknown): bigint {
  const types = obj(obj(body).data, "data object").gpuTypes;
  if (!Array.isArray(types)) throw new Error("gpuTypes missing");
  const hits = types.filter((t) => isObject(t) && t.id === "NVIDIA H100 80GB HBM3");
  if (hits.length !== 1) throw new Error(`expected one gpu type, found ${hits.length}`);
  return numberToMicro(obj(obj(hits[0]).lowestPrice, "lowestPrice").uninterruptablePrice);
}

export function extractVerda(body: unknown): bigint {
  if (!Array.isArray(body)) throw new Error("instance types missing");
  const hits = body.filter((t) => isObject(t) && isObject(t.gpu) && t.gpu.description === "1x H100 SXM5 80GB" && t.gpu.number_of_gpus === 1);
  if (hits.length === 0) throw new Error("no matching instance type");
  const prices = hits.map((t: Record<string, unknown>) => {
    if (t.currency !== "usd") throw new Error("currency is not usd");
    if (typeof t.price_per_hour !== "string" || !VERDA_PRICE.test(t.price_per_hour)) throw new Error("price_per_hour must be a plain decimal string");
    return decimalMicro(t.price_per_hour);
  });
  return prices.reduce((min, p) => (p < min ? p : min));
}

export function extractShadeform(body: unknown): bigint {
  const listings = obj(body).instance_types;
  if (!Array.isArray(listings)) throw new Error("instance_types missing");
  const cheapest = new Map<string, number>();
  for (const l of listings) {
    if (!isObject(l) || !isObject(l.configuration)) continue;
    const c = l.configuration;
    if (c.gpu_type !== "H100" || c.num_gpus !== 1 || c.interconnect !== "sxm5") continue;
    if (typeof l.cloud !== "string" || !CLOUD.test(l.cloud)) throw new Error("invalid cloud name");
    if (l.cloud === "verda") continue;
    const cents = l.hourly_price;
    if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) throw new Error("hourly_price is not positive integer cents");
    cheapest.set(l.cloud, Math.min(cheapest.get(l.cloud) ?? cents, cents));
  }
  if (cheapest.size < 4) throw new Error(`${cheapest.size} clouds listed, 4 required`);
  return median([...cheapest.values()].map((cents) => BigInt(cents) * 10n ** BigInt(DECIMALS) / 100n));
}

const EXTRACT: Record<SourceName, (body: unknown) => bigint> = { akash: extractAkash, runpod: extractRunpod, verda: extractVerda, shadeform: extractShadeform };

export async function readSource(source: SourceName, fetcher: Fetcher): Promise<Reading> {
  try {
    const { url, method, headers, body, maxBytes } = sourceRequest(source);
    const res = await fetcher(url, { method, headers, body, signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("response is not valid JSON");
    }
    const micro = EXTRACT[source](json);
    if (micro < SANITY_MIN || micro > SANITY_MAX) throw new Error("outside the 0.50 to 20.00 sanity bounds");
    return { source, ok: true, usd: fmt(micro, DECIMALS) };
  } catch (error) {
    return { source, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchComposite(fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Composite> {
  const readings = await Promise.all(SOURCE_NAMES.map((s) => readSource(s, fetcher)));
  const good = readings.filter((r) => r.ok && r.usd !== undefined).map((r) => decimalMicro(r.usd!));
  return {
    kind: "PREVIEW",
    note: "Fetched now by this plugin from the public endpoints under the workflow's rules. It is a preview, not the accepted on-chain observation: the accepted index is the on-chain mark, which the CRE workflow derives from responses its nodes agree on, and the two can differ in timing, in which sources answered, and in the last digits.",
    indexUsd: good.length >= MIN_SOURCES ? fmt(median(good), DECIMALS) : null,
    validSources: good.length,
    required: MIN_SOURCES,
    readings,
  };
}
