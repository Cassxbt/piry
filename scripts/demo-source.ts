import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { demoTerms } from '../workflow/demo.ts';
import { indexIdentity, validateTerms, type IndexTerms } from '../workflow/validation.ts';

export const FAULTS = ['none', 'stale', 'duplicate', 'wrong-hardware'] as const;
export type Fault = (typeof FAULTS)[number];
export type Scope = 'full' | 'to-date';
export type SourceOptions = {
  terms: IndexTerms;
  seed: number;
  priceMin: number;
  priceMax: number;
  publishLagSeconds: number;
};

const MICRO = 1_000_000;
export const PRE_PERIOD_SLOTS = 1000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The path depends only on the seed and slot index, so every request, node and restart sees the same series.
// Index 0 is the first period slot; earlier indices are the pre-period slots that feed the spot mark.
function series({ terms, seed, priceMin, priceMax }: SourceOptions) {
  const scale = 10n ** BigInt(terms.priceDecimals);
  const low = BigInt(Math.round(priceMin * MICRO)) * scale / BigInt(MICRO);
  const high = BigInt(Math.round(priceMax * MICRO)) * scale / BigInt(MICRO);
  const random = mulberry32(seed);
  let price = low + (high - low) / 2n;
  const total = (terms.periodEnd - terms.periodStart) / terms.slotSeconds;
  return Array.from({ length: PRE_PERIOD_SLOTS + total }, (_, offset) => {
    const slotStart = terms.periodStart + (offset - PRE_PERIOD_SLOTS) * terms.slotSeconds;
    const row = { slotStart, observedAt: slotStart + Math.floor(random() * terms.slotSeconds), price: price.toString() };
    price += BigInt(Math.round((random() - 0.5) * 0.4 * MICRO)) * (high - low) / BigInt(MICRO);
    if (price < low) price = low + (low - price);
    if (price > high) price = high - (price - high);
    price = price < low ? low : price > high ? high : price;
    return row;
  });
}

// Returns undefined while the source has nothing it could honestly publish yet. The "to-date" scope is the mark
// source: the latest completed slot's observation until the first period slot completes, then the period-to-date set.
export function buildDataset(options: SourceOptions, nowSeconds: number, scope: Scope, fault: Fault): object | undefined {
  const { terms, publishLagSeconds } = options;
  const honestPublishedAt = nowSeconds - publishLagSeconds;
  const total = (terms.periodEnd - terms.periodStart) / terms.slotSeconds;
  const completed = Math.min(total, Math.floor((honestPublishedAt - terms.periodStart) / terms.slotSeconds));
  if (scope === 'full' ? honestPublishedAt < terms.periodEnd : completed < -PRE_PERIOD_SLOTS + 1) return undefined;
  const rows = series(options);
  const observations = scope === 'full' ? rows.slice(PRE_PERIOD_SLOTS)
    : completed < 1 ? rows.slice(PRE_PERIOD_SLOTS + completed - 1, PRE_PERIOD_SLOTS + completed)
      : rows.slice(PRE_PERIOD_SLOTS, PRE_PERIOD_SLOTS + completed);
  if (fault === 'duplicate') {
    if (observations.length > 1) observations[1] = { ...observations[0] };
    else observations.push({ ...observations[0] });
  }
  const { maxPublicationAgeSeconds: _policy, ...datasetTerms } = terms;
  return {
    schemaVersion: 1,
    ...datasetTerms,
    hardware: fault === 'wrong-hardware' ? { ...terms.hardware, model: 'NVIDIA H100' } : terms.hardware,
    ...indexIdentity(terms),
    publishedAt: fault === 'stale' ? nowSeconds - terms.maxPublicationAgeSeconds - 1 : honestPublishedAt,
    observations,
  };
}

export type DemoSource = { server: Server; setFault(fault: Fault): void; close(): Promise<void> };

export async function startDemoSource(
  options: SourceOptions,
  { port = 8787, now = () => Math.floor(Date.now() / 1000), fault: initialFault = 'none' }: { port?: number; now?: () => number; fault?: Fault } = {},
): Promise<DemoSource> {
  validateTerms(options.terms);
  let fault = initialFault;
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-piry-mode': 'DEMO' });
      response.end(JSON.stringify(body));
    };
    const { port: boundPort } = server.address() as AddressInfo;
    if (request.headers.host !== `127.0.0.1:${boundPort}` && request.headers.host !== `localhost:${boundPort}`) {
      return send(403, { mode: 'DEMO', error: 'loopback host required' });
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const dataset = path === '/dataset.json' ? 'full' : path === '/dataset-to-date.json' ? 'to-date' : undefined;
    if (dataset) {
      if (request.method !== 'GET') return send(405, { mode: 'DEMO', error: 'GET only' });
      const body = buildDataset(options, now(), dataset, fault);
      return body ? send(200, body) : send(409, { mode: 'DEMO', error: 'no honest dataset is published yet' });
    }
    if (path.startsWith('/fault/')) {
      if (request.method !== 'POST') return send(405, { mode: 'DEMO', error: 'POST only' });
      const requested = path.slice('/fault/'.length) as Fault;
      if (!FAULTS.includes(requested)) return send(400, { mode: 'DEMO', error: `fault must be one of ${FAULTS.join(', ')}` });
      fault = requested;
      return send(200, { mode: 'DEMO', fault });
    }
    if (path === '/') return send(200, { mode: 'DEMO', fault, terms: options.terms, seed: options.seed });
    return send(404, { mode: 'DEMO', error: 'not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    setFault: (next) => { fault = next; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

const USAGE = `usage: bun scripts/demo-source.ts [options]
  --config <path>       take index terms from a workflow config file (its "terms" object)
  --period-start <unix> without --config: series start (default: next slot boundary)
  --slot-seconds <n>    without --config: slot length (default 60)
  --slots <n>           without --config: number of slots (default 5)
  --max-age <seconds>   without --config: publication freshness window (default 120)
  --port <n>            loopback port (default 8787)
  --seed <n>            price path seed (default 20261012)
  --price-min <usd>     lower bound of the price path (default 2)
  --price-max <usd>     upper bound of the price path (default 3.5)
  --publish-lag <s>     publish this many seconds behind the wall clock (default 3)
  --fault <name>        one of ${FAULTS.join(', ')} (default none); switch live with POST /fault/<name>
endpoints (loopback only, synthetic DEMO data):
  GET /dataset.json           settlement dataset, available once the period has ended
  GET /dataset-to-date.json   mark dataset: the latest completed slot until the first period slot completes, then period-to-date`;

function parseArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || !['config', 'period-start', 'slot-seconds', 'slots', 'max-age',
      'port', 'seed', 'price-min', 'price-max', 'publish-lag', 'fault'].includes(key.slice(2))) throw new Error(USAGE);
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  if (process.argv.includes('--help')) return console.log(USAGE);
  const args = parseArguments(process.argv.slice(2));
  const number = (name: string, fallback: number) => (args.has(name) ? Number(args.get(name)) : fallback);
  const slotSeconds = number('slot-seconds', 60);
  const periodStart = number('period-start', Math.ceil(Date.now() / 1000 / slotSeconds) * slotSeconds);
  const terms: IndexTerms = args.has('config')
    ? JSON.parse(readFileSync(args.get('config')!, 'utf8')).terms
    : {
      ...demoTerms, slotSeconds, periodStart, periodEnd: periodStart + number('slots', 5) * slotSeconds,
      maxPublicationAgeSeconds: number('max-age', 120),
    };
  const fault = (args.get('fault') ?? 'none') as Fault;
  if (!FAULTS.includes(fault)) throw new Error(USAGE);
  const options: SourceOptions = {
    terms, seed: number('seed', 20261012), priceMin: number('price-min', 2), priceMax: number('price-max', 3.5),
    publishLagSeconds: number('publish-lag', 3),
  };
  const source = await startDemoSource(options, { port: number('port', 8787), fault });
  const { port } = source.server.address() as AddressInfo;
  console.log(JSON.stringify({
    mode: 'DEMO', note: 'synthetic prices, loopback only', fault, terms,
    endpoints: [`http://127.0.0.1:${port}/dataset.json`, `http://127.0.0.1:${port}/dataset-to-date.json`],
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
