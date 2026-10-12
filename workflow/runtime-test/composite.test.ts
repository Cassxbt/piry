import assert from 'node:assert/strict';
import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock, HttpActionsMock, newTestRuntime, test, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test';
import { decodeAbiParameters, hexToBytes, parseAbiParameters, toHex } from 'viem';
import series from '../../deployments/series.composite-h100.example.json' with { type: 'json' };
import example from '../config.composite.example.json' with { type: 'json' };
import { AKASH_SOURCE_URL } from '../akash.js';
import { COMPOSITE_SOURCE_LABEL, compositeSnapshot, type CompositeSource, type FailureReason, type SourceResult } from '../composite.js';
import { configSchema, type Config } from '../config.js';
import { initWorkflow } from '../init.js';
import { onMark } from '../mark.js';
import { REPORT_ABI } from '../report.js';
import { onSettlement } from '../settlement.js';
import { COMPOSITE_SOURCES, indexIdentity } from '../validation.js';
import { compositeTerms, expected, liveBodies, periodEnd } from '../test/composite-fixtures.js';
import type { Body } from '../test/akash-fixtures.js';

const markFeed = '0x3333333333333333333333333333333333333333';
const config: Config = {
  executionMode: 'authenticated', sourceUrl: COMPOSITE_SOURCE_LABEL, schedule: '0 */5 * * * *',
  chainName: 'monad-testnet', chainId: '10143', receiver: '0x1111111111111111111111111111111111111111',
  market: '0x2222222222222222222222222222222222222222', gasLimit: '500000', terms: compositeTerms,
  mark: { feed: markFeed, sourceUrl: COMPOSITE_SOURCE_LABEL, schedule: '0 */15 * * * *', gasLimit: '300000', observedAtMarginSeconds: 15 },
};
const settleNow = periodEnd + 95;
const markNow = periodEnd - 6 * 3600 + 17;
const selector = EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet'];
const runtime = (now: number, value = config) => newTestRuntime(null, { timeProvider: () => now * 1000 }, value);
const accepted = { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' } as const;
const markAbi = parseAbiParameters('(address feed,uint256 chainId,bytes32 indexId,uint256 indexPrice,uint64 observedAt,bytes32 evidenceHash)');
const sourceOf = (url: string): CompositeSource => COMPOSITE_SOURCES.find(source => ({
  akash: 'console-api.akash.network', runpod: 'api.runpod.io', shadeform: 'api.shadeform.ai', verda: 'api.verda.com',
})[source] === new URL(url).host)!;

type Reply = { status?: number; body?: unknown };
type Seen = { source: CompositeSource; method: string; url: string; body: string; headers: Record<string, string[]>; store?: boolean };

function mockSources(replies: Partial<Record<CompositeSource, Reply>> = {}) {
  const seen: Seen[] = [];
  HttpActionsMock.testInstance().sendRequest = (request) => {
    const source = sourceOf(request.url);
    seen.push({
      source, method: request.method, url: request.url, body: new TextDecoder().decode(request.body),
      headers: Object.fromEntries(Object.entries(request.multiHeaders).map(([name, entry]) => [name, entry.values])),
      store: request.cacheSettings?.store,
    });
    const reply = replies[source] ?? {};
    const body = reply.body ?? liveBodies[source]();
    return { statusCode: reply.status ?? 200, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') };
  };
  return seen;
}

function mockWrites(result: object = accepted) {
  const writes: { receiver: Uint8Array; gasLimit?: bigint; payload: `0x${string}` }[] = [];
  EvmMock.testInstance(selector).writeReport = (request) => {
    writes.push({
      receiver: request.receiver, gasLimit: request.gasConfig?.gasLimit,
      payload: toHex(request.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)),
    });
    return result;
  };
  return writes;
}

const live = (): Record<CompositeSource, SourceResult> => ({
  akash: { ok: true, ...expected.akash }, runpod: { ok: true, ...expected.runpod },
  shadeform: { ok: true, ...expected.shadeform }, verda: { ok: true, ...expected.verda },
});
const expectedHash = (now: number, scope: 'settlement' | 'mark', failed: Partial<Record<CompositeSource, FailureReason>> = {}) => {
  const results = live();
  for (const [source, reason] of Object.entries(failed)) results[source as CompositeSource] = { ok: false, reason: reason as FailureReason };
  return compositeSnapshot(results, compositeTerms, now, scope).evidenceHash;
};

test('settlement reads all four sources, each by its own request, and submits the exact market payload', () => {
  const seen = mockSources();
  const writes = mockWrites();
  const outcome = onSettlement(runtime(settleNow));
  assert.deepEqual(seen.map(request => request.source), ['akash', 'runpod', 'shadeform', 'verda']);
  assert.deepEqual(seen.map(request => request.url), [
    AKASH_SOURCE_URL, 'https://api.runpod.io/graphql',
    'https://api.shadeform.ai/v1/instances/types?gpu_type=H100&num_gpus=1', 'https://api.verda.com/v1/instance-types',
  ]);
  assert.deepEqual(seen.map(request => request.method), ['GET', 'POST', 'GET', 'GET']);
  assert(seen.every(request => request.store === false));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].receiver, hexToBytes(config.receiver as `0x${string}`));
  assert.equal(writes[0].gasLimit, 500000n);
  const [report] = decodeAbiParameters(REPORT_ABI, writes[0].payload);
  const identity = indexIdentity(compositeTerms);
  assert.equal(report.market.toLowerCase(), config.market);
  assert.equal(report.indexId, identity.indexId);
  assert.equal(report.specHash, identity.specHash);
  assert.equal(report.priceDecimals, 6);
  assert.equal(report.periodEnd, BigInt(periodEnd));
  assert.equal(report.price, expected.median);
  assert.equal(report.publishedAt, BigInt(periodEnd + 60));
  assert.equal(report.evidenceHash, expectedHash(settleNow, 'settlement'));
  assert.match(outcome, /^COMPOSITE: .*independently verify.*evidence=0x/);
});

test('the RunPod request is a JSON POST carrying the fixed GraphQL query', () => {
  const seen = mockSources();
  mockWrites();
  onMark(runtime(markNow));
  const runpod = seen.find(request => request.source === 'runpod')!;
  assert.deepEqual(runpod.headers['Content-Type'], ['application/json']);
  assert.deepEqual(runpod.headers.Accept, ['application/json']);
  assert.deepEqual(JSON.parse(runpod.body), {
    query: '{ gpuTypes(input:{id:"NVIDIA H100 80GB HBM3"}) { id lowestPrice(input:{gpuCount:1}){ uninterruptablePrice } } }',
  });
  for (const request of seen.filter(entry => entry.source !== 'runpod')) {
    assert.equal(request.body, '');
    assert.equal(request.headers['Content-Type'], undefined);
  }
});

test('mark publishes the composite median to the feed', () => {
  mockSources();
  const writes = mockWrites();
  const outcome = onMark(runtime(markNow));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].receiver, hexToBytes(markFeed));
  assert.equal(writes[0].gasLimit, 300000n);
  const [report] = decodeAbiParameters(markAbi, writes[0].payload);
  assert.equal(report.indexId, indexIdentity(compositeTerms).indexId);
  assert.equal(report.indexPrice, expected.median);
  assert.equal(report.observedAt, BigInt(markNow - 17 - 15));
  assert.equal(report.evidenceHash, expectedHash(markNow, 'mark'));
  assert.match(outcome, /^COMPOSITE mark: .*composite-median-v1; price=3388500; observedAt=\d+; evidence=0x/);
});

test('runs within the same minute produce the same evidence, the next minute a new one', () => {
  mockSources();
  mockWrites();
  const evidence = (now: number) => /evidence=(0x[0-9a-f]{64})/.exec(onMark(runtime(now)))![1];
  assert.equal(evidence(markNow), evidence(markNow - 17 + 59));
  assert.notEqual(evidence(markNow), evidence(markNow - 17 + 60));
});

test('settlement outside its window is refused without contacting any source or the chain', () => {
  const seen = mockSources();
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(periodEnd - 1)), /settlement/);
  assert.throws(() => onSettlement(runtime(periodEnd + compositeTerms.maxPublicationAgeSeconds + 1)), /settlement/);
  assert.equal(seen.length, 0);
  assert.equal(writes.length, 0);
});

const failures: [string, CompositeSource, Reply, FailureReason][] = [
  ['an HTTP error', 'runpod', { status: 503 }, 'http-status'],
  ['malformed JSON', 'akash', { body: '{' }, 'invalid-response'],
  ['an oversized body', 'shadeform', { body: ' '.repeat(65537) }, 'response-too-large'],
  ['a GraphQL error body', 'runpod', { body: { errors: [{ message: 'boom' }] } }, 'invalid-response'],
  ['an unmatched selector', 'akash', { body: (() => { const b = liveBodies.akash(); b.models = []; return b; })() }, 'invalid-response'],
  ['a thin provider set', 'akash', { body: (() => { const b = liveBodies.akash(); b.models.find((m: Body) => m.model === 'h100' && m.interface === 'SXM5').providerAvailability.total = 1; return b; })() }, 'invalid-response'],
  ['too few clouds', 'shadeform', { body: (() => { const b = liveBodies.shadeform(); b.instance_types = b.instance_types.slice(0, 2); return b; })() }, 'invalid-response'],
  ['a non-usd Verda listing', 'verda', { body: (() => { const b = liveBodies.verda(); b.forEach((e: Body) => { e.currency = 'eur'; }); return b; })() }, 'invalid-response'],
  ['a price outside the sanity bounds', 'runpod', { body: (() => { const b = liveBodies.runpod(); b.data.gpuTypes[0].lowestPrice.uninterruptablePrice = 42; return b; })() }, 'outside-sanity-bounds'],
];
for (const [name, source, reply, reason] of failures) {
  for (const [handler, now, scope, run] of [['settlement', settleNow, 'settlement', onSettlement], ['mark', markNow, 'mark', onMark]] as const) {
    test(`${handler} continues on the other three sources when ${source} returns ${name}, and records the failure`, () => {
      mockSources({ [source]: reply });
      const writes = mockWrites();
      run(runtime(now));
      assert.equal(writes.length, 1);
      const payload = writes[0].payload;
      const hash = handler === 'settlement' ? decodeAbiParameters(REPORT_ABI, payload)[0].evidenceHash : decodeAbiParameters(markAbi, payload)[0].evidenceHash;
      assert.equal(hash, expectedHash(now, scope, { [source]: reason }));
    });
  }
}

test('two failing sources fail the run closed before any EVM write', () => {
  mockSources({ runpod: { status: 500 }, verda: { body: '[]' } });
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(settleNow)), /2 valid sources, 3 required/);
  assert.throws(() => onMark(runtime(markNow)), /2 valid sources, 3 required/);
  assert.equal(writes.length, 0);
});

test('every source failing fails the run closed', () => {
  mockSources({ akash: { status: 500 }, runpod: { status: 500 }, shadeform: { status: 500 }, verda: { status: 500 } });
  const writes = mockWrites();
  assert.throws(() => onMark(runtime(markNow)), /0 valid sources/);
  assert.equal(writes.length, 0);
});

test('Verda gets a larger response cap than the other sources', () => {
  const padded = liveBodies.verda();
  const filler = padded.find((entry: Body) => !entry.gpu.description.includes('H100'));
  while (JSON.stringify(padded).length < 143_000) padded.push({ ...structuredClone(filler), instance_type: `FILL.${padded.length}` });
  const size = JSON.stringify(padded).length;
  assert(size >= 143_000 && size < 200_000, String(size));
  mockSources({ verda: { body: padded } });
  const writes = mockWrites();
  onMark(runtime(markNow));
  assert.equal(decodeAbiParameters(markAbi, writes[0].payload)[0].evidenceHash, expectedHash(markNow, 'mark'));

  while (JSON.stringify(padded).length <= 200_000) padded.push({ ...structuredClone(filler), instance_type: `FILL.${padded.length}` });
  mockSources({ verda: { body: padded } });
  writes.length = 0;
  onMark(runtime(markNow));
  assert.equal(decodeAbiParameters(markAbi, writes[0].payload)[0].evidenceHash, expectedHash(markNow, 'mark', { verda: 'response-too-large' }));
});

for (const status of ['unknown', 'reverted', 'transaction-failed'] as const) {
  test(`authenticated composite path rejects ${status} delivery`, () => {
    mockSources();
    mockWrites({
      txStatus: status === 'transaction-failed' ? 'TX_STATUS_REVERTED' : 'TX_STATUS_SUCCESS',
      ...(status === 'reverted' ? { receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' as const } : {}),
    });
    assert.throws(() => onSettlement(runtime(settleNow)), /delivery|receiver/);
    assert.throws(() => onMark(runtime(markNow)), /delivery|receiver/);
  });
}

test('simulation with omitted receiver status remains explicitly unverified', () => {
  mockSources();
  mockWrites({ txStatus: 'TX_STATUS_SUCCESS' });
  assert.match(onSettlement(runtime(settleNow, { ...config, executionMode: 'simulation' })), /delivery unverified/);
});

test('both handlers are registered for a composite configuration', () => {
  const [settlement, mark] = initWorkflow(config);
  assert.equal(settlement.fn, onSettlement);
  assert.equal(mark.fn, onMark);
});

test('composite configuration pins the source label and refuses real or foreign URLs', () => {
  const mark = config.mark!;
  configSchema.parse(config);
  configSchema.parse({ ...config, executionMode: 'simulation' });
  for (const url of [AKASH_SOURCE_URL, 'https://api.runpod.io/graphql', 'http://127.0.0.1:8787/dataset.json', `${COMPOSITE_SOURCE_LABEL}/`, '']) {
    assert.throws(() => configSchema.parse({ ...config, executionMode: 'simulation', sourceUrl: url }), /exactly/, url);
    assert.throws(() => configSchema.parse({ ...config, executionMode: 'simulation', mark: { ...mark, sourceUrl: url } }), /exactly/, url);
  }
  assert.throws(() => configSchema.parse({ ...config, terms: { ...compositeTerms, minSources: 2 } }));
  assert.throws(() => configSchema.parse({ ...config, terms: { ...compositeTerms, extra: true } }));
  assert.throws(() => configSchema.parse({ ...config, terms: { ...compositeTerms, sources: { ...compositeTerms.sources, runpod: { ...compositeTerms.sources.runpod, extra: 1 } } } }));
  assert.throws(() => configSchema.parse({ ...config, terms: { ...compositeTerms, sources: { akash: compositeTerms.sources.akash } } }));
});

test('composite example configuration fails until every placeholder is replaced and matches the series example', () => {
  const filled = structuredClone(example) as Record<string, any>;
  assert.throws(() => configSchema.parse(filled));
  filled.receiver = '0x1111111111111111111111111111111111111111';
  filled.market = '0x2222222222222222222222222222222222222222';
  filled.mark.feed = markFeed;
  assert.throws(() => configSchema.parse(filled));
  filled.terms.periodStart = compositeTerms.periodStart;
  filled.terms.periodEnd = periodEnd;
  const parsed = configSchema.parse(filled);
  assert.equal(parsed.executionMode, 'simulation');
  assert.equal(parsed.sourceUrl, COMPOSITE_SOURCE_LABEL);
  assert.equal(parsed.mark?.sourceUrl, COMPOSITE_SOURCE_LABEL);
  assert.deepEqual(parsed.terms, compositeTerms);

  const fromSeries = {
    ...series.index.terms, priceDecimals: series.priceDecimals, periodStart: compositeTerms.periodStart, periodEnd,
    maxPublicationAgeSeconds: series.maxReportAge,
  };
  assert.deepEqual(indexIdentity(fromSeries as typeof compositeTerms), indexIdentity(parsed.terms));
  assert.equal(series.maxReportAge, parsed.terms.maxPublicationAgeSeconds);
  assert.deepEqual(series.bounds, { lower: '2000000', upper: '4000000' });
  assert.equal(series.fallbackDelay, 604800);
  assert.deepEqual(series.receiver, { mode: 'simulation' });
  assert.equal(series.forwarder, '0xB9F79d863261869B234c481D1f9A7af84AeAd192');
  assert.match(series.collateral, /^REPLACE_WITH_/);
});
