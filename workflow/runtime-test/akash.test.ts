import assert from 'node:assert/strict';
import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock, HttpActionsMock, newTestRuntime, test, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test';
import { decodeAbiParameters, hexToBytes, parseAbiParameters, toHex } from 'viem';
import series from '../../deployments/series.akash-h100.example.json' with { type: 'json' };
import example from '../config.akash.example.json' with { type: 'json' };
import { AKASH_SOURCE_URL, validateAkashResponse } from '../akash.js';
import { configSchema, type Config } from '../config.js';
import { initWorkflow } from '../init.js';
import { onMark } from '../mark.js';
import { REPORT_ABI } from '../report.js';
import { onSettlement } from '../settlement.js';
import { indexIdentity } from '../validation.js';
import { akashTerms, h100, liveGpuPrices, periodEnd, type Body } from '../test/akash-fixtures.js';
import { mockChain } from './chain.js';

const markFeed = '0x3333333333333333333333333333333333333333';
const config: Config = {
  executionMode: 'authenticated', sourceUrl: AKASH_SOURCE_URL, schedule: '0 */5 * * * *',
  chainName: 'monad-testnet', chainId: '10143', receiver: '0x1111111111111111111111111111111111111111',
  market: '0x2222222222222222222222222222222222222222', gasLimit: '500000', terms: akashTerms,
  mark: { feed: markFeed, sourceUrl: AKASH_SOURCE_URL, schedule: '0 */15 * * * *', gasLimit: '300000', observedAtMarginSeconds: 15 },
};
const settleNow = periodEnd + 95;
const markNow = periodEnd - 6 * 3600 + 17;
const selector = EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet'];
const runtime = (now: number, value = config) => {
  mockChain(value);
  return newTestRuntime(null, { timeProvider: () => now * 1000 }, value);
};
const response = (body: unknown, statusCode = 200) => ({
  statusCode, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64'),
});
const accepted = { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' } as const;
const markAbi = parseAbiParameters('(address feed,uint256 chainId,bytes32 indexId,uint256 indexPrice,uint64 observedAt,bytes32 evidenceHash)');

function mockSource(body: unknown = liveGpuPrices(), statusCode = 200) {
  const requests: string[] = [];
  HttpActionsMock.testInstance().sendRequest = (request) => {
    requests.push(request.url);
    assert.equal(request.method, 'GET');
    assert.equal(request.cacheSettings?.store, false);
    return response(body, statusCode);
  };
  return requests;
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

test('settlement handler reads the live Akash response and submits the exact market payload', () => {
  const requests = mockSource();
  const writes = mockWrites();
  const outcome = onSettlement(runtime(settleNow));
  assert.deepEqual(requests, [AKASH_SOURCE_URL]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].receiver, hexToBytes(config.receiver as `0x${string}`));
  assert.equal(writes[0].gasLimit, 500000n);
  assert.equal((writes[0].payload.length - 2) / 2, 320);
  const [report] = decodeAbiParameters(REPORT_ABI, writes[0].payload);
  const expected = validateAkashResponse(liveGpuPrices(), akashTerms, settleNow, 'settlement');
  const identity = indexIdentity(akashTerms);
  assert.equal(report.market.toLowerCase(), config.market);
  assert.equal(report.chainId, 10143n);
  assert.equal(report.indexId, identity.indexId);
  assert.equal(report.specHash, identity.specHash);
  assert.equal(report.priceDecimals, 6);
  assert.equal(report.periodStart, BigInt(akashTerms.periodStart));
  assert.equal(report.periodEnd, BigInt(periodEnd));
  assert.equal(report.price, 2730000n);
  assert.equal(report.publishedAt, BigInt(periodEnd + 60));
  assert.equal(report.evidenceHash, expected.evidenceHash);
  assert.match(outcome, /^AKASH: .*independently verify.*evidence=0x/);
});

test('mark handler publishes the current snapshot to the feed before settlement', () => {
  const requests = mockSource();
  const writes = mockWrites();
  const outcome = onMark(runtime(markNow));
  assert.deepEqual(requests, [AKASH_SOURCE_URL]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].receiver, hexToBytes(markFeed));
  assert.equal(writes[0].gasLimit, 300000n);
  assert.equal((writes[0].payload.length - 2) / 2, 192);
  const [report] = decodeAbiParameters(markAbi, writes[0].payload);
  assert.equal(report.feed.toLowerCase(), markFeed);
  assert.equal(report.indexId, indexIdentity(akashTerms).indexId);
  assert.equal(report.indexPrice, 2730000n);
  assert.equal(report.observedAt, BigInt(markNow - 17 - 15));
  assert.equal(report.evidenceHash, validateAkashResponse(liveGpuPrices(), akashTerms, markNow, 'mark').evidenceHash);
  assert.match(outcome, /^AKASH mark: .*akash-console-snapshot-v1; price=2730000; observedAt=\d+; evidence=0x/);
});

test('the median field is published when the terms select it', () => {
  mockSource();
  const writes = mockWrites();
  onMark(runtime(markNow, { ...config, terms: { ...akashTerms, priceField: 'med' } }));
  assert.equal(decodeAbiParameters(markAbi, writes[0].payload)[0].indexPrice, 2560000n);
});

test('runs within the same minute produce the same evidence, the next minute a new one', () => {
  mockSource();
  mockWrites();
  const evidence = (now: number) => /evidence=(0x[0-9a-f]{64})/.exec(onMark(runtime(now)))![1];
  assert.equal(evidence(markNow), evidence(markNow - 17 + 59));
  assert.notEqual(evidence(markNow), evidence(markNow - 17 + 60));
});

test('settlement before periodEnd is refused without contacting the API or the chain', () => {
  const requests = mockSource();
  const writes = mockWrites();
  assert.throws(() => onSettlement(runtime(periodEnd - 1)), /settlement/);
  assert.throws(() => onSettlement(runtime(periodEnd + akashTerms.maxPublicationAgeSeconds + 1)), /settlement/);
  assert.equal(requests.length, 0);
  assert.equal(writes.length, 0);
});

const sources: [string, (body: Body) => void | string, number?][] = [
  ['http error', () => {}, 503],
  ['malformed json', () => '{'],
  ['oversized body', () => ' '.repeat(65537)],
  ['unmatched selector', body => { h100(body).model = 'h200'; }],
  ['duplicated model', body => { body.models.push(structuredClone(h100(body))); }],
  ['non-USD currency', body => { h100(body).price.currency = 'uakt'; }],
  ['null price', body => { h100(body).price = null; }],
  ['thin provider set', body => { h100(body).providerAvailability.total = 1; }],
  ['price below sanity floor', body => { h100(body).price.weightedAverage = 0.25; }],
  ['price above sanity ceiling', body => { h100(body).price.weightedAverage = 42; }],
  ['non-numeric price', body => { h100(body).price.weightedAverage = '2.73'; }],
];
for (const [name, change, statusCode] of sources) {
  for (const [handler, now, run] of [['settlement', settleNow, onSettlement], ['mark', markNow, onMark]] as const) {
    test(`${handler} handler refuses ${name} before any EVM write`, () => {
      const body = liveGpuPrices();
      const replaced = change(body);
      mockSource(replaced ?? body, statusCode);
      const writes = mockWrites();
      assert.throws(() => run(runtime(now)));
      assert.equal(writes.length, 0);
    });
  }
}

for (const status of ['unknown', 'reverted', 'transaction-failed'] as const) {
  test(`authenticated AKASH path rejects ${status} delivery`, () => {
    mockSource();
    mockWrites({
      txStatus: status === 'transaction-failed' ? 'TX_STATUS_REVERTED' : 'TX_STATUS_SUCCESS',
      ...(status === 'reverted' ? { receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' as const } : {}),
    });
    assert.throws(() => onSettlement(runtime(settleNow)), /delivery|receiver/);
    assert.throws(() => onMark(runtime(markNow)), /delivery|receiver/);
  });
}

test('simulation with omitted receiver status remains explicitly unverified', () => {
  mockSource();
  mockWrites({ txStatus: 'TX_STATUS_SUCCESS' });
  assert.match(onSettlement(runtime(settleNow, { ...config, executionMode: 'simulation' })), /delivery unverified/);
});

test('both handlers are registered for an AKASH configuration', () => {
  const [settlement, mark] = initWorkflow(config);
  assert.equal(settlement.fn, onSettlement);
  assert.equal(mark.fn, onMark);
});

test('AKASH configuration pins the exact HTTPS source for settlement and mark', () => {
  const mark = config.mark!;
  configSchema.parse(config);
  configSchema.parse({ ...config, executionMode: 'simulation' });
  for (const url of [
    'http://console-api.akash.network/v1/gpu-prices', `${AKASH_SOURCE_URL}/`, `${AKASH_SOURCE_URL}?debug=true`,
    'https://console-api.akash.network/v1/gpu-prices#x', 'https://console-api.akash.network:8443/v1/gpu-prices',
    'https://CONSOLE-API.akash.network/v1/gpu-prices', 'https://console-api.akash.network/v1/gpu-prices/debug',
    'https://console-api.akash.network.evil.example/v1/gpu-prices', 'http://127.0.0.1:8787/v1/gpu-prices', '',
  ]) {
    assert.throws(() => configSchema.parse({ ...config, executionMode: 'simulation', sourceUrl: url }), /exactly/, url);
    assert.throws(() => configSchema.parse({ ...config, executionMode: 'simulation', mark: { ...mark, sourceUrl: url } }), /exactly/, url);
  }
});

test('AKASH configuration validates the terms and refuses unknown fields', () => {
  for (const terms of [
    { ...akashTerms, sourceId: 'other' }, { ...akashTerms, priceField: 'avg' }, { ...akashTerms, minProviders: 0 },
    { ...akashTerms, sanityBounds: { min: '20.00', max: '0.50' } }, { ...akashTerms, periodEnd: akashTerms.periodStart },
    { ...akashTerms, extra: true }, { ...akashTerms, selector: { vendor: 'nvidia', model: 'h100', ram: '80Gi' } },
    { ...akashTerms, mode: 'LIVE' },
  ]) assert.throws(() => configSchema.parse({ ...config, terms }));
  const { sanityBounds: _bounds, ...incomplete } = akashTerms;
  assert.throws(() => configSchema.parse({ ...config, terms: incomplete }));
});

test('AKASH example configuration fails until every placeholder is replaced and matches the series example', () => {
  const filled = structuredClone(example) as Record<string, any>;
  assert.throws(() => configSchema.parse(filled));
  filled.receiver = '0x1111111111111111111111111111111111111111';
  filled.market = '0x2222222222222222222222222222222222222222';
  filled.mark.feed = '0x3333333333333333333333333333333333333333';
  assert.throws(() => configSchema.parse(filled));
  filled.terms.periodStart = akashTerms.periodStart;
  filled.terms.periodEnd = periodEnd;
  const parsed = configSchema.parse(filled);
  assert.equal(parsed.executionMode, 'simulation');
  assert.equal(parsed.sourceUrl, AKASH_SOURCE_URL);
  assert.equal(parsed.mark?.sourceUrl, AKASH_SOURCE_URL);
  assert.deepEqual(parsed.terms, akashTerms);

  const { terms } = series.index;
  const fromSeries = {
    ...terms, priceDecimals: series.priceDecimals, periodStart: akashTerms.periodStart, periodEnd,
    maxPublicationAgeSeconds: series.maxReportAge,
  };
  assert.deepEqual(indexIdentity(fromSeries as typeof akashTerms), indexIdentity(parsed.terms));
  assert.equal(series.maxReportAge, parsed.terms.maxPublicationAgeSeconds);
  assert.deepEqual(series.bounds, { lower: '2000000', upper: '4000000' });
  assert.equal(series.fallbackDelay, 604800);
  assert.deepEqual(series.receiver, { mode: 'simulation' });
  assert.equal(series.forwarder, '0xB9F79d863261869B234c481D1f9A7af84AeAd192');
  assert.match(series.collateral, /^REPLACE_WITH_/);
});
