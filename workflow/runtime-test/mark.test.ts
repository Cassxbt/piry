import assert from 'node:assert/strict';
import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock, HttpActionsMock, newTestRuntime, test, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test';
import { decodeAbiParameters, hexToBytes, parseAbiParameters, toHex } from 'viem';
import exampleConfig from '../config.testnet.example.json' with { type: 'json' };
import { configSchema, type Config } from '../config.js';
import { demoDataset, demoTerms } from '../demo.js';
import { initWorkflow } from '../init.js';
import { onMark } from '../mark.js';
import { indexIdentity, validateMarkDataset, validatePartialDataset } from '../validation.js';
import { onSettlement } from '../settlement.js';
import { partialDataset, spotDataset } from '../test/fixtures.js';

const markFeed = '0x3333333333333333333333333333333333333333';
const config: Config = {
  executionMode: 'authenticated', sourceUrl: 'https://example.invalid/demo.json', schedule: '0 */5 * * * *',
  chainName: 'monad-testnet', chainId: '10143', receiver: '0x1111111111111111111111111111111111111111',
  market: '0x2222222222222222222222222222222222222222', gasLimit: '500000', terms: demoTerms,
  mark: { feed: markFeed, sourceUrl: 'https://example.invalid/demo-to-date.json', schedule: '0 * * * * *', gasLimit: '300000', observedAtMarginSeconds: 15 },
};
const data = partialDataset(2);
const now = data.publishedAt + 30;
const runtime = (value = config) => newTestRuntime(null, { timeProvider: () => now * 1000 }, value);
const selector = EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet'];
const response = (body: unknown, statusCode = 200) => ({
  statusCode, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64'),
});

function mockSource(body: unknown = data, statusCode = 200) {
  HttpActionsMock.testInstance().sendRequest = (request) => {
    assert.equal(request.url, config.mark?.sourceUrl);
    assert.equal(request.method, 'GET');
    assert.equal(request.cacheSettings?.store, false);
    return response(body, statusCode);
  };
}

test('SDK mark handler validates period-to-date data and submits the exact 192-byte feed payload', () => {
  mockSource();
  let writes = 0;
  EvmMock.testInstance(selector).writeReport = (request) => {
    writes++;
    assert.deepEqual(request.receiver, hexToBytes(markFeed));
    assert.equal(request.gasConfig?.gasLimit, 300000n);
    assert(request.report);
    const payload = toHex(request.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    assert.equal((payload.length - 2) / 2, 192);
    const decoded = decodeAbiParameters(parseAbiParameters('(address feed,uint256 chainId,bytes32 indexId,uint256 indexPrice,uint64 observedAt,bytes32 evidenceHash)'), payload);
    const [report] = decoded;
    assert.equal(report.feed.toLowerCase(), markFeed);
    assert.equal(report.chainId, 10143n);
    assert.equal(report.indexId, indexIdentity(demoTerms).indexId);
    assert.equal(report.indexPrice, 2500000n);
    assert.equal(report.observedAt, BigInt(demoTerms.periodStart + demoTerms.slotSeconds + 30 - 15));
    assert.equal(report.evidenceHash, validatePartialDataset(data, demoTerms, now).evidenceHash);
    return { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' };
  };
  const outcome = onMark(runtime());
  assert.match(outcome, /independently verify/);
  assert.match(outcome, /equal-slot-mean-floor-v1; price=2500000/);
  assert.equal(writes, 1);
});

for (const failure of ['http', 'missing', 'in-progress', 'stale', 'duplicate', 'hardware', 'malformed', 'oversized'] as const) {
  test(`SDK mark handler refuses ${failure} source before any EVM write`, () => {
    const body = structuredClone(data);
    if (failure === 'missing') body.observations.pop();
    if (failure === 'in-progress') body.observations.push({ ...demoDataset.observations[2] });
    if (failure === 'stale') body.publishedAt = now - demoTerms.maxPublicationAgeSeconds - 1;
    if (failure === 'duplicate') body.observations[1] = { ...body.observations[0] };
    if (failure === 'hardware') body.hardware.model = 'NVIDIA H100';
    mockSource(body, failure === 'http' ? 503 : 200);
    if (failure === 'malformed' || failure === 'oversized') {
      HttpActionsMock.testInstance().sendRequest = () => response(failure === 'malformed' ? '{' : ' '.repeat(65537));
    }
    let writes = 0;
    EvmMock.testInstance(selector).writeReport = () => { writes++; return { txStatus: 'TX_STATUS_SUCCESS' }; };
    assert.throws(() => onMark(runtime()));
    assert.equal(writes, 0);
  });
}

const spot = spotDataset();
const spotRuntime = () => newTestRuntime(null, { timeProvider: () => (spot.publishedAt + 30) * 1000 }, config);

test('SDK mark handler publishes the pre-period spot price before the period starts', () => {
  mockSource(spot);
  let writes = 0;
  EvmMock.testInstance(selector).writeReport = (request) => {
    writes++;
    assert.deepEqual(request.receiver, hexToBytes(markFeed));
    const payload = toHex(request.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    const [report] = decodeAbiParameters(parseAbiParameters('(address feed,uint256 chainId,bytes32 indexId,uint256 indexPrice,uint64 observedAt,bytes32 evidenceHash)'), payload);
    assert.equal(report.indexPrice, 2100000n);
    assert.equal(report.observedAt, BigInt(demoTerms.periodStart - 2 * demoTerms.slotSeconds + 30 - 15));
    assert.equal(report.evidenceHash, validateMarkDataset(spot, demoTerms, spot.publishedAt + 30).evidenceHash);
    return { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' };
  };
  assert.match(onMark(spotRuntime()), /pre-period-spot-v1; price=2100000/);
  assert.equal(writes, 1);
});

for (const failure of ['stale', 'older-slot', 'second-observation', 'hardware'] as const) {
  test(`SDK mark handler refuses ${failure} pre-period spot before any EVM write`, () => {
    const body = spotDataset();
    if (failure === 'stale') body.publishedAt = spot.publishedAt - demoTerms.maxPublicationAgeSeconds - 31;
    if (failure === 'older-slot') body.observations[0].slotStart -= demoTerms.slotSeconds;
    if (failure === 'second-observation') body.observations.push({ ...body.observations[0] });
    if (failure === 'hardware') body.hardware.model = 'NVIDIA H100';
    mockSource(body);
    let writes = 0;
    EvmMock.testInstance(selector).writeReport = () => { writes++; return { txStatus: 'TX_STATUS_SUCCESS' }; };
    assert.throws(() => onMark(spotRuntime()));
    assert.equal(writes, 0);
  });
}

for (const status of ['unknown', 'reverted', 'transaction-failed'] as const) {
  test(`SDK authenticated mark path rejects ${status} delivery`, () => {
    mockSource();
    EvmMock.testInstance(selector).writeReport = () => ({
      txStatus: status === 'transaction-failed' ? 'TX_STATUS_REVERTED' : 'TX_STATUS_SUCCESS',
      ...(status === 'reverted' ? { receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' as const } : {}),
    });
    assert.throws(() => onMark(runtime()), /delivery|receiver/);
  });
}

test('SDK mark simulation with omitted receiver status remains explicitly unverified', () => {
  mockSource();
  EvmMock.testInstance(selector).writeReport = () => ({ txStatus: 'TX_STATUS_SUCCESS' });
  assert.match(onMark(runtime({ ...config, executionMode: 'simulation' })), /delivery unverified/);
});

test('SDK mark handler requires the mark configuration and touches nothing without it', () => {
  let calls = 0;
  HttpActionsMock.testInstance().sendRequest = () => { calls++; return response(data); };
  EvmMock.testInstance(selector).writeReport = () => { calls++; return { txStatus: 'TX_STATUS_SUCCESS' }; };
  const { mark: _mark, ...withoutMark } = config;
  assert.throws(() => onMark(runtime(withoutMark)), /mark/);
  assert.equal(calls, 0);
});

test('settlement handler is unaffected by a mark configuration', () => {
  HttpActionsMock.testInstance().sendRequest = (request) => {
    assert.equal(request.url, config.sourceUrl);
    return response(demoDataset);
  };
  let writes = 0;
  EvmMock.testInstance(selector).writeReport = (request) => {
    writes++;
    assert.deepEqual(request.receiver, hexToBytes(config.receiver as `0x${string}`));
    assert.equal(request.gasConfig?.gasLimit, 500000n);
    assert.equal(request.report?.rawReport.length, REPORT_METADATA_HEADER_LENGTH + 320);
    return { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' };
  };
  const settleNow = (demoDataset.publishedAt + 30) * 1000;
  assert.match(onSettlement(newTestRuntime(null, { timeProvider: () => settleNow }, config)), /independently verify/);
  assert.equal(writes, 1);
});

test('mark handler is registered after settlement and only when configured', () => {
  const [settlement, mark] = initWorkflow(config);
  assert.equal(initWorkflow(config).length, 2);
  assert.equal(settlement.fn, onSettlement);
  assert.equal(mark.fn, onMark);
  const { mark: _mark, ...withoutMark } = config;
  const only = initWorkflow(withoutMark);
  assert.equal(only.length, 1);
  assert.equal(only[0].fn, onSettlement);
});

test('mark configuration refuses remote plain HTTP, bad feed and unknown fields', () => {
  const mark = config.mark!;
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, sourceUrl: 'http://example.invalid/data' } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, sourceUrl: 'http://localhost:8787/data' } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, feed: '0x00' } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, feed: `0x${'00'.repeat(20)}` } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, gasLimit: '0' } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, extra: true } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, observedAtMarginSeconds: -1 } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, observedAtMarginSeconds: 601 } }));
  assert.throws(() => configSchema.parse({ ...config, mark: { ...mark, observedAtMarginSeconds: undefined } }));
  configSchema.parse({ ...config, executionMode: 'simulation', mark: { ...mark, sourceUrl: 'http://127.0.0.1:8787/dataset-to-date.json' } });
  const { mark: _mark, ...withoutMark } = config;
  configSchema.parse(withoutMark);
});

test('testnet example configuration fails until every placeholder is replaced', () => {
  const example = JSON.parse(JSON.stringify(exampleConfig));
  assert.throws(() => configSchema.parse(example));
  const filled = structuredClone(example);
  filled.receiver = '0x1111111111111111111111111111111111111111';
  filled.market = '0x2222222222222222222222222222222222222222';
  filled.mark.feed = '0x3333333333333333333333333333333333333333';
  assert.throws(() => configSchema.parse(filled));
  filled.terms.periodStart = 1791676800;
  filled.terms.periodEnd = 1791677100;
  const parsed = configSchema.parse(filled);
  assert.equal(parsed.executionMode, 'simulation');
  assert.equal(parsed.chainName, 'monad-testnet');
  assert.equal(parsed.chainId, '10143');
});
