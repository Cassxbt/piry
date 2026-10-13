import { EVMClient } from '@chainlink/cre-sdk';
import { EvmMock } from '@chainlink/cre-sdk/test';
import { bytesToHex, decodeFunctionData, encodeFunctionResult, hexToBytes, type Abi } from 'viem';
import type { Config } from '../config.js';
import { FEED_ABI, MARKET_ABI } from '../preflight.js';
import { indexIdentity } from '../validation.js';

export type ChainState = {
  indexId: string; specHash: string; priceDecimals: number; periodStart: bigint; periodEnd: bigint;
  settlementAuthority: string; settled: boolean; feedMarket: string; feedIndexId: string;
};

// What the deployed market and feed report when the workflow configuration is correct.
const matchingChain = (config: Config): ChainState => {
  const { terms } = config;
  const identity = indexIdentity(terms);
  return {
    indexId: identity.indexId, specHash: identity.specHash, priceDecimals: terms.priceDecimals,
    periodStart: BigInt(terms.periodStart), periodEnd: BigInt(terms.periodEnd),
    settlementAuthority: config.receiver, settled: false, feedMarket: config.market, feedIndexId: identity.indexId,
  };
};

// Serves only the preflight's view calls; writes stay with the test's own writeReport handler.
export function mockChain(config: Config, overrides: Partial<ChainState> = {}) {
  const state = { ...matchingChain(config), ...overrides };
  const answers: Record<string, Record<string, unknown>> = {
    [config.market.toLowerCase()]: {
      indexId: state.indexId, specHash: state.specHash, priceDecimals: state.priceDecimals, periodStart: state.periodStart,
      periodEnd: state.periodEnd, settlementAuthority: state.settlementAuthority, settled: state.settled,
    },
    ...(config.mark ? { [config.mark.feed.toLowerCase()]: { market: state.feedMarket, indexId: state.feedIndexId } } : {}),
  };
  const calls: string[] = [];
  EvmMock.testInstance(EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chainName]).callContract = (request) => {
    const to = bytesToHex(request.call!.to).toLowerCase();
    const abi: Abi = to === config.market.toLowerCase() ? MARKET_ABI : FEED_ABI;
    const { functionName } = decodeFunctionData({ abi, data: bytesToHex(request.call!.data) });
    if (!(functionName in (answers[to] ?? {}))) throw new Error(`unexpected read ${functionName} on ${to}`);
    calls.push(`${to}.${functionName}`);
    return { data: Buffer.from(hexToBytes(encodeFunctionResult({ abi, functionName, result: answers[to][functionName] } as never))).toString('base64') };
  };
  return { state, calls };
}
