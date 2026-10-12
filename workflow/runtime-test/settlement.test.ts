import assert from 'node:assert/strict';
import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock, HttpActionsMock, newTestRuntime, test, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test';
import { decodeAbiParameters, hexToBytes, toHex } from 'viem';
import { configSchema, type Config } from '../config.js';
import { demoDataset, demoTerms } from '../demo.js';
import { REPORT_ABI } from '../report.js';
import { onSettlement } from '../settlement.js';

const config: Config = {
  executionMode: 'authenticated', sourceUrl: 'https://example.invalid/demo.json', schedule: '0 */5 * * * *',
  chainName: 'monad-testnet', chainId: '10143', receiver: '0x1111111111111111111111111111111111111111',
  market: '0x2222222222222222222222222222222222222222', gasLimit: '500000', terms: demoTerms,
};
const now = demoDataset.publishedAt + 30;
const runtime = (value = config) => newTestRuntime(null, { timeProvider: () => now * 1000 }, value);
const response = (data: unknown = demoDataset, statusCode = 200) => ({
  statusCode, body: Buffer.from(JSON.stringify(data)).toString('base64'),
});

function mockSource(data: unknown = demoDataset, statusCode = 200) {
  HttpActionsMock.testInstance().sendRequest = (request) => {
    assert.equal(request.url, config.sourceUrl);
    assert.equal(request.method, 'GET');
    assert.equal(request.cacheSettings?.store, false);
    return response(data, statusCode);
  };
}

test('SDK handler validates HTTP data and submits the exact market payload', () => {
  mockSource();
  let writes = 0;
  EvmMock.testInstance(EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet']).writeReport = (request) => {
    writes++;
    assert.deepEqual(request.receiver, hexToBytes(config.receiver as `0x${string}`));
    assert.equal(request.gasConfig?.gasLimit, 500000n);
    assert(request.report);
    const payload = toHex(request.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    const [report] = decodeAbiParameters(REPORT_ABI, payload);
    assert.equal(report.market.toLowerCase(), config.market);
    assert.equal(report.chainId, 10143n);
    assert.equal(report.price, 2333333n);
    assert.equal(report.periodStart, BigInt(demoTerms.periodStart));
    return { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' };
  };
  assert.match(onSettlement(runtime()), /independently verify/);
  assert.equal(writes, 1);
});

for (const failure of ['http', 'missing', 'stale', 'malformed', 'oversized'] as const) {
  test(`SDK handler refuses ${failure} source before any EVM write`, () => {
    const data = structuredClone(demoDataset);
    if (failure === 'missing') data.observations.pop();
    if (failure === 'stale') data.publishedAt = demoTerms.periodEnd - 1;
    mockSource(data, failure === 'http' ? 503 : 200);
    if (failure === 'malformed' || failure === 'oversized') {
      HttpActionsMock.testInstance().sendRequest = () => ({ statusCode: 200,
        body: Buffer.from(failure === 'malformed' ? '{' : ' '.repeat(65537)).toString('base64') });
    }
    let writes = 0;
    EvmMock.testInstance(EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet']).writeReport = () => {
      writes++; return { txStatus: 'TX_STATUS_SUCCESS' };
    };
    assert.throws(() => onSettlement(runtime()));
    assert.equal(writes, 0);
  });
}

for (const status of ['unknown', 'reverted', 'transaction-failed'] as const) {
  test(`SDK authenticated path rejects ${status} delivery`, () => {
    mockSource();
    EvmMock.testInstance(EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet']).writeReport = () => ({
      txStatus: status === 'transaction-failed' ? 'TX_STATUS_REVERTED' : 'TX_STATUS_SUCCESS',
      ...(status === 'reverted' ? { receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' as const } : {}),
    });
    assert.throws(() => onSettlement(runtime()), /delivery|receiver/);
  });
}

test('SDK simulation with omitted receiver status remains explicitly unverified', () => {
  mockSource();
  EvmMock.testInstance(EVMClient.SUPPORTED_CHAIN_SELECTORS['monad-testnet']).writeReport = () => ({ txStatus: 'TX_STATUS_SUCCESS' });
  assert.match(onSettlement(runtime({ ...config, executionMode: 'simulation' })), /delivery unverified/);
});

test('configuration refuses chain mismatch and remote plain HTTP', () => {
  assert.throws(() => configSchema.parse({ ...config, chainId: '143' }));
  assert.throws(() => configSchema.parse({ ...config, sourceUrl: 'http://example.invalid/data' }));
  assert.throws(() => configSchema.parse({ ...config, sourceUrl: 'http://localhost:8787/data' }));
  configSchema.parse({ ...config, executionMode: 'simulation', sourceUrl: 'http://127.0.0.1:8787/data' });
});
