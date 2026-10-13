import assert from 'node:assert/strict';
import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock, HttpActionsMock, newTestRuntime, test, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test';
import { decodeAbiParameters, hexToBytes, keccak256, parseAbiParameters, toBytes, toHex } from 'viem';
import series from '../../deployments/series.composite-h100.example.json' with { type: 'json' };
import manifest from '../../deployments/monad-testnet.public.json' with { type: 'json' };
import example from '../config.composite.example.json' with { type: 'json' };
import liveConfig from '../config.composite.live.json' with { type: 'json' };
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
import { mockChain, type ChainState } from './chain.js';

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
const runtime = (now: number, value = config, chain: Partial<ChainState> = {}) => {
  mockChain(value, chain);
  return newTestRuntime(null, { timeProvider: () => now * 1000 }, value);
};
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

const threeSourcesAllowed: Config = { ...config, settlementFullQuorumSeconds: 0 };
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
      run(runtime(now, threeSourcesAllowed));
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

const longWindow: Config = { ...config, terms: { ...compositeTerms, maxPublicationAgeSeconds: 86400 } };
const fullQuorumSeconds = 14400;
const settledPrice = (payload: `0x${string}`) => decodeAbiParameters(REPORT_ABI, payload)[0].price;

test('a four-source mark does not authorize a three-source settlement inside the full-quorum window', () => {
  const at = periodEnd + 120;
  mockSources();
  let writes = mockWrites();
  onMark(runtime(at, longWindow));
  assert.equal(writes.length, 1);
  assert.equal(decodeAbiParameters(markAbi, writes[0].payload)[0].indexPrice, expected.median);

  mockSources({ shadeform: { status: 503 } });
  writes = mockWrites();
  assert.throws(() => onSettlement(runtime(at, longWindow)), /settlement needs 4 valid sources .* got 3/);
  assert.equal(writes.length, 0);
});

for (const [offset, settles] of [[fullQuorumSeconds - 1, false], [fullQuorumSeconds, true], [fullQuorumSeconds + 60, true]] as const) {
  test(`direct settlement on three sources ${settles ? 'succeeds' : 'is refused'} at expiry + ${offset}s`, () => {
    mockSources({ shadeform: { status: 503 } });
    const writes = mockWrites();
    const run = () => onSettlement(runtime(periodEnd + offset, longWindow));
    if (!settles) {
      assert.throws(run, /settlement needs 4 valid sources/);
      assert.equal(writes.length, 0);
      return;
    }
    run();
    assert.equal(writes.length, 1);
    assert.equal(settledPrice(writes[0].payload), 2730000n);
  });
}

test('four sources settle at the first eligible minute', () => {
  mockSources();
  const writes = mockWrites();
  onSettlement(runtime(periodEnd + 60, longWindow));
  assert.equal(settledPrice(writes[0].payload), expected.median);
});

test('one malformed matching listing drops a source and so cannot settle inside the full-quorum window', () => {
  const body = liveBodies.shadeform();
  body.instance_types.find((entry: Body) => entry.configuration.interconnect === 'sxm5' && entry.cloud !== 'verda').hourly_price = null;
  mockSources({ shadeform: { body } });
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(periodEnd + 120, longWindow)), /settlement needs 4 valid sources/);
  assert.equal(writes.length, 0);
});

test('settlementFullQuorumSeconds moves the boundary; the policy is not part of the pinned terms', () => {
  const custom: Config = { ...longWindow, settlementFullQuorumSeconds: 600 };
  mockSources({ shadeform: { status: 503 } });
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(periodEnd + 599, custom)), /settlement needs 4 valid sources/);
  onSettlement(runtime(periodEnd + 600, custom));
  assert.equal(writes.length, 1);
  assert.throws(() => configSchema.parse({ ...config, terms: { ...compositeTerms, settlementFullQuorumSeconds: 600 } }));
});

const wrongHash = `0x${'11'.repeat(32)}`;
const wrongAddress = '0x4444444444444444444444444444444444444444';
const preflightFailures: [string, Partial<ChainState>, RegExp, ('settlement' | 'mark')[]][] = [
  ['market specHash', { specHash: wrongHash }, /specHash/, ['settlement', 'mark']],
  ['market indexId', { indexId: wrongHash }, /indexId/, ['settlement', 'mark']],
  ['market price decimals', { priceDecimals: 8 }, /priceDecimals/, ['settlement', 'mark']],
  ['market periodStart', { periodStart: BigInt(compositeTerms.periodStart) + 1n }, /periodStart/, ['settlement', 'mark']],
  ['market periodEnd', { periodEnd: BigInt(periodEnd) + 1n }, /periodEnd/, ['settlement', 'mark']],
  ['market already settled', { settled: true }, /already settled/, ['settlement', 'mark']],
  ['settlement authority', { settlementAuthority: wrongAddress }, /settlementAuthority/, ['settlement']],
  ['feed market', { feedMarket: wrongAddress }, /feed market/, ['mark']],
  ['feed indexId', { feedIndexId: wrongHash }, /feed indexId/, ['mark']],
];
for (const [name, chain, message, handlers] of preflightFailures) {
  for (const handler of handlers) {
    test(`${handler} refuses before any fetch or report when the ${name} differs on chain`, () => {
      const seen = mockSources();
      const writes = mockWrites();
      const [run, now] = handler === 'settlement' ? [onSettlement, settleNow] : [onMark, markNow];
      assert.throws(() => run(runtime(now, config, chain)), message);
      assert.equal(seen.length, 0);
      assert.equal(writes.length, 0);
    });
  }
}

for (const handler of ['settlement', 'mark'] as const) {
  test(`${handler} refuses before any fetch when the chain cannot be read`, () => {
    const seen = mockSources();
    const writes = mockWrites();
    const [run, now] = handler === 'settlement' ? [onSettlement, settleNow] : [onMark, markNow];
    const rt = runtime(now);
    EvmMock.testInstance(selector).callContract = () => { throw new Error('rpc down'); };
    assert.throws(() => run(rt));
    assert.equal(seen.length, 0);
    assert.equal(writes.length, 0);
  });
}

test('the preflight reads only the market for settlement and the market plus the feed for a mark', () => {
  mockSources();
  mockWrites();
  const reads = (run: typeof onMark, now: number) => {
    const { calls } = mockChain(config);
    run(newTestRuntime(null, { timeProvider: () => now * 1000 }, config));
    return calls;
  };
  const market = config.market.toLowerCase();
  const feed = markFeed.toLowerCase();
  assert.deepEqual(reads(onSettlement, settleNow).map(call => call.split('.')[0]).filter((to, i, all) => all.indexOf(to) === i), [market]);
  assert.deepEqual(reads(onMark, markNow).map(call => call.split('.')[0]).filter((to, i, all) => all.indexOf(to) === i), [market, feed]);
});

const margined: Config = { ...longWindow, settlementMarginSeconds: 15 };
const publishedAtOf = (payload: `0x${string}`) => Number(decodeAbiParameters(REPORT_ABI, payload)[0].publishedAt);

for (const second of [0, 14, 15, 59]) {
  test(`settlement inside the expiry minute (+${second}s) is refused because the margined time precedes expiry`, () => {
    const seen = mockSources();
    const writes = mockWrites();
    assert.throws(() => onSettlement(runtime(periodEnd + second, margined)), /margin/);
    assert.equal(writes.length, 0);
  });

  test(`settlement ${second}s into the first eligible minute backdates publishedAt, keeps the evidence unchanged and never leads the chain`, () => {
    const now = periodEnd + 60 + second;
    mockSources();
    const writes = mockWrites();
    const rt = runtime(now, margined);
    const logs: string[] = [];
    rt.log = (message: string) => { logs.push(message); };
    onSettlement(rt);
    const [report] = decodeAbiParameters(REPORT_ABI, writes[0].payload);
    assert.equal(report.publishedAt, BigInt(periodEnd + 45));
    assert(report.publishedAt <= BigInt(now - 15));
    assert(report.publishedAt >= BigInt(periodEnd));
    assert.equal(report.evidenceHash, expectedHash(now, 'settlement'));
    const evidence = JSON.parse(logs.find(line => line.startsWith('PIRY_EVIDENCE'))!.split(' ').slice(2).join(' '));
    assert.equal(evidence.observedAt, periodEnd + 60);
  });
}

test('a later minute is backdated by the same margin', () => {
  mockSources();
  const writes = mockWrites();
  onSettlement(runtime(periodEnd + 3 * 60 + 41, margined));
  assert.equal(publishedAtOf(writes[0].payload), periodEnd + 3 * 60 - 15);
});

test('with an expiry inside a minute the margined time must still reach expiry', () => {
  const offMinute = (margin: number): Config => ({
    ...margined, settlementMarginSeconds: margin, terms: { ...longWindow.terms, periodEnd: periodEnd + 30 },
  });
  mockSources();
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(periodEnd + 59, offMinute(15))), /settlement/);
  onSettlement(runtime(periodEnd + 60, offMinute(15)));
  assert.equal(publishedAtOf(writes[0].payload), periodEnd + 45);
  assert.throws(() => onSettlement(runtime(periodEnd + 60, offMinute(40))), /margin/);
});

test('without a configured margin the settlement time is the snapshot minute, as before', () => {
  mockSources();
  const writes = mockWrites();
  onSettlement(runtime(periodEnd + 60, longWindow));
  assert.equal(publishedAtOf(writes[0].payload), periodEnd + 60);
});

for (const [name, run, now, scope] of [
  ['settlement', onSettlement, settleNow, 'settlement'], ['mark', onMark, markNow, 'mark'],
] as const) {
  test(`${name} logs one PIRY_EVIDENCE line carrying the exact preimage of the evidence hash`, () => {
    mockSources();
    const writes = mockWrites();
    const rt = runtime(now);
    const logs: string[] = [];
    rt.log = (message: string) => { logs.push(message); };
    run(rt);
    const lines = logs.filter(line => line.includes('PIRY_EVIDENCE'));
    assert.equal(lines.length, 1);
    const match = /^PIRY_EVIDENCE (0x[0-9a-f]{64}) (\{.*\})$/.exec(lines[0]);
    assert(match, lines[0]);
    const [, hash, json] = match;
    assert.equal(keccak256(toBytes(json)), hash);
    assert.equal(json, compositeSnapshot(live(), compositeTerms, now, scope).canonicalEvidence);
    const payload = writes[0].payload;
    assert.equal(hash, name === 'settlement' ? decodeAbiParameters(REPORT_ABI, payload)[0].evidenceHash : decodeAbiParameters(markAbi, payload)[0].evidenceHash);
  });
}

test('the evidence line records a failed source and still hashes to the delivered evidence', () => {
  mockSources({ shadeform: { status: 503 } });
  const writes = mockWrites();
  const rt = runtime(periodEnd + fullQuorumSeconds, longWindow);
  const logs: string[] = [];
  rt.log = (message: string) => { logs.push(message); };
  onSettlement(rt);
  const [, hash, json] = /^PIRY_EVIDENCE (0x[0-9a-f]{64}) (\{.*\})$/.exec(logs.find(line => line.startsWith('PIRY_EVIDENCE'))!)!;
  assert.equal(keccak256(toBytes(json)), hash);
  assert.equal(JSON.parse(json).sources.shadeform.reason, 'http-status');
  assert.equal(decodeAbiParameters(REPORT_ABI, writes[0].payload)[0].evidenceHash, hash);
});

test('settlement policy keys are optional, bounded and outside the series identity', () => {
  configSchema.parse({ ...config, settlementFullQuorumSeconds: 0, settlementMarginSeconds: 0 });
  configSchema.parse({ ...config, settlementFullQuorumSeconds: 86400, settlementMarginSeconds: 600 });
  for (const bad of [{ settlementFullQuorumSeconds: -1 }, { settlementFullQuorumSeconds: 86401 }, { settlementFullQuorumSeconds: 1.5 },
    { settlementMarginSeconds: -1 }, { settlementMarginSeconds: 601 }, { settlementMarginSeconds: 0.5 }]) {
    assert.throws(() => configSchema.parse({ ...config, ...bad }), JSON.stringify(bad));
  }
});

test('the public live configuration carries the policy and still matches the immutable series', () => {
  const parsed = configSchema.parse(liveConfig);
  assert.equal(parsed.settlementFullQuorumSeconds, 14400);
  assert.equal(parsed.settlementMarginSeconds, 15);
  assert.equal(parsed.mark?.observedAtMarginSeconds, 15);
  const identity = indexIdentity(parsed.terms);
  assert.equal(identity.indexId, manifest.liveSeries.terms.indexId);
  assert.equal(identity.specHash, manifest.liveSeries.terms.specHash);
  assert.equal(liveConfig.terms.minSources, 3);
  assert.equal(String(parsed.terms.periodEnd), manifest.liveSeries.terms.periodEnd);
  assert.equal(parsed.market.toLowerCase(), manifest.liveSeries.contracts.computeMarket.address.toLowerCase());
  assert.equal(parsed.receiver.toLowerCase(), manifest.liveSeries.contracts.simulationSettlementReceiver.address.toLowerCase());
  assert.equal(parsed.mark?.feed.toLowerCase(), manifest.liveSeries.contracts.piryMarkFeed.address.toLowerCase());
});
