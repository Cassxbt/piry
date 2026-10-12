import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { demoTerms } from '../demo.js';
import { validateDataset, validateMarkDataset, validatePartialDataset, type IndexTerms } from '../validation.js';
import { FAULTS, PRE_PERIOD_SLOTS, buildDataset, startDemoSource, type SourceOptions } from '../../scripts/demo-source.ts';

const slot = 60;
const terms: IndexTerms = { ...demoTerms, slotSeconds: slot, periodStart: 1_800_000_000, periodEnd: 1_800_000_300, maxPublicationAgeSeconds: 120 };
const options: SourceOptions = { terms, seed: 7, priceMin: 2, priceMax: 3.5, publishLagSeconds: 3 };
const lag = options.publishLagSeconds;
const afterEnd = terms.periodEnd + lag + 10;
const midway = terms.periodStart + 2 * slot + lag + 10;
type Row = { slotStart: number; observedAt: number; price: string };
const rows = (data: object | undefined) => (data as { observations: Row[] }).observations;

test('full dataset validates after the period and is labelled DEMO', () => {
  const data = buildDataset(options, afterEnd, 'full', 'none');
  assert(data);
  assert.equal((data as { mode: string }).mode, 'DEMO');
  assert.equal(rows(data).length, 5);
  const result = validateDataset(data, terms, afterEnd);
  assert(result.price >= 2_000_000n && result.price <= 3_500_000n);
});

test('price path is seeded, bounded and independent of the clock', () => {
  const prices = (seed: number, at: number) => rows(buildDataset({ ...options, seed }, at, 'full', 'none')).map(row => row.price);
  assert.deepEqual(prices(7, afterEnd), prices(7, afterEnd + 50));
  assert.notDeepEqual(prices(7, afterEnd), prices(8, afterEnd));
  for (let seed = 0; seed < 50; seed++) {
    for (const price of prices(seed, afterEnd)) assert(BigInt(price) >= 2_000_000n && BigInt(price) <= 3_500_000n);
  }
});

test('period-to-date dataset gains one completed slot at a time and always validates', () => {
  const full = rows(buildDataset(options, afterEnd, 'full', 'none'));
  for (let completed = 1; completed <= 5; completed++) {
    const at = terms.periodStart + completed * slot + lag + 1;
    const data = buildDataset(options, at, 'to-date', 'none');
    assert(data, `slot ${completed}`);
    assert.equal(rows(data).length, completed);
    assert.deepEqual(rows(data), full.slice(0, completed));
    assert.equal(validatePartialDataset(data, terms, at).slots, completed);
  }
});

test('settlement data is withheld until the period ends; marks are withheld only beyond the pre-period lead-in', () => {
  assert.equal(buildDataset(options, terms.periodEnd + lag - 1, 'full', 'none'), undefined);
  assert(buildDataset(options, terms.periodEnd + lag, 'full', 'none'));
  assert(buildDataset(options, terms.periodStart - 10, 'to-date', 'none'));
  assert.equal(buildDataset(options, terms.periodStart - PRE_PERIOD_SLOTS * slot - 2 * slot, 'to-date', 'none'), undefined);
});

test('before the first period slot completes the mark source serves the latest completed slot as a spot observation', () => {
  const full = rows(buildDataset(options, afterEnd, 'full', 'none'));
  for (const at of [terms.periodStart - 10 * slot - 5, terms.periodStart - 5, terms.periodStart + slot / 2, terms.periodStart + slot + lag - 1]) {
    const data = buildDataset(options, at, 'to-date', 'none');
    assert(data, `at ${at}`);
    const spot = rows(data);
    assert.equal(spot.length, 1);
    assert(spot[0].slotStart < terms.periodStart);
    const result = validateMarkDataset(data, terms, at);
    assert.equal(result.methodology, 'pre-period-spot-v1');
    assert(result.price >= 2_000_000n && result.price <= 3_500_000n);
  }
  const spotAt = (at: number) => rows(buildDataset(options, at, 'to-date', 'none'))[0];
  assert.deepEqual(spotAt(terms.periodStart - 5), spotAt(terms.periodStart - 5 + 1));
  assert.notEqual(spotAt(terms.periodStart - 5).slotStart, spotAt(terms.periodStart - 5 - slot).slotStart);
  assert.deepEqual(full[0], rows(buildDataset(options, terms.periodStart + slot + lag, 'to-date', 'none'))[0]);
});

test('mark observation times strictly increase from the lead-in through the end of the period', () => {
  const seen: number[] = [];
  for (let at = terms.periodStart - 4 * slot; at <= terms.periodEnd + lag + 10; at += slot) {
    seen.push(validateMarkDataset(buildDataset(options, at, 'to-date', 'none'), terms, at).observedAt);
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(new Set(seen).size, seen.length);
});

test('the period-to-date dataset after the period ends equals the settlement dataset', () => {
  assert.deepEqual(buildDataset(options, afterEnd, 'to-date', 'none'), buildDataset(options, afterEnd, 'full', 'none'));
});

for (const [scope, at, validate] of [
  ['full', afterEnd, (data: object) => validateDataset(data, terms, afterEnd)],
  ['to-date', midway, (data: object) => validatePartialDataset(data, terms, midway)],
  ['spot', terms.periodStart - 10, (data: object) => validateMarkDataset(data, terms, terms.periodStart - 10)],
] as const) {
  for (const [fault, pattern] of [['stale', /publication/], ['duplicate', /duplicate|complete/], ['wrong-hardware', /hardware|binding/]] as const) {
    test(`${fault} ${scope} data is refused by the workflow validators`, () => {
      assert.throws(() => validate(buildDataset(options, at, scope === 'full' ? 'full' : 'to-date', fault)!), pattern);
    });
  }
}

test('every advertised fault is covered above', () => {
  assert.deepEqual([...FAULTS], ['none', 'stale', 'duplicate', 'wrong-hardware']);
});

async function get(port: number, path: string, method = 'GET', host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP server is loopback only, serves both datasets and can switch faults at runtime', async () => {
  let clock = terms.periodStart - 100;
  const source = await startDemoSource(options, { port: 0, now: () => clock });
  try {
    const { port } = source.server.address() as AddressInfo;
    assert.equal((source.server.address() as AddressInfo).address, '127.0.0.1');

    const early = await get(port, '/dataset.json');
    assert.equal(early.status, 409);
    assert.equal(JSON.parse(early.body).mode, 'DEMO');
    const spot = await get(port, '/dataset-to-date.json');
    assert.equal(spot.status, 200);
    assert.equal(validateMarkDataset(JSON.parse(spot.body), terms, clock).methodology, 'pre-period-spot-v1');

    clock = midway;
    const toDate = await get(port, '/dataset-to-date.json');
    assert.equal(toDate.status, 200);
    assert.equal(toDate.headers['x-piry-mode'], 'DEMO');
    assert.match(String(toDate.headers['content-type']), /application\/json/);
    assert.equal(toDate.headers['cache-control'], 'no-store');
    validatePartialDataset(JSON.parse(toDate.body), terms, clock);
    assert.equal((await get(port, '/dataset.json')).status, 409);

    clock = afterEnd;
    const full = await get(port, '/dataset.json');
    assert.equal(full.status, 200);
    validateDataset(JSON.parse(full.body), terms, clock);

    assert.equal((await get(port, '/fault/duplicate', 'POST')).status, 200);
    const faulty = JSON.parse((await get(port, '/dataset.json')).body);
    assert.throws(() => validateDataset(faulty, terms, clock), /duplicate/);
    assert.equal(JSON.parse((await get(port, '/')).body).fault, 'duplicate');
    assert.equal((await get(port, '/fault/none', 'POST')).status, 200);
    validateDataset(JSON.parse((await get(port, '/dataset.json')).body), terms, clock);

    assert.equal((await get(port, '/fault/bogus', 'POST')).status, 400);
    assert.equal((await get(port, '/dataset.json', 'POST')).status, 405);
    assert.equal((await get(port, '/fault/stale')).status, 405);
    assert.equal((await get(port, '/missing')).status, 404);
    assert.equal((await get(port, '/dataset.json', 'GET', 'attacker.example')).status, 403);
  } finally {
    await source.close();
  }
});
