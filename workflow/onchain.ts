import {
  ConsensusAggregationByFields, EVMClient, HTTPClient, TxStatus, bytesToBase64, median, prepareReportRequest,
  type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import type { Hex } from "viem";
import { snapshotTime, validateAkashResponse, type AkashScope } from "./akash.js";
import type { Config } from "./config.js";
import {
  compositeSnapshot, extractSource, failureReason, sourceRequest,
  type CompositeSource, type Observation, type SourceResult,
} from "./composite.js";
import { deliveryOutcome } from "./delivery.js";
import {
  COMPOSITE_SOURCES, MAX_RESPONSE_BYTES, type AkashTerms, type CompositeTerms, type ValidatedIndex, type ValidatedMark,
} from "./validation.js";

export function fetchSource(
  requester: HTTPSendRequester, url: string, { body, maxBytes = MAX_RESPONSE_BYTES }: { body?: string; maxBytes?: number } = {},
): unknown {
  const response = requester.sendRequest({
    url, method: body === undefined ? "GET" : "POST", timeout: "5s",
    multiHeaders: {
      Accept: { values: ["application/json"] },
      ...(body === undefined ? {} : { "Content-Type": { values: ["application/json"] } }),
    },
    ...(body === undefined ? {} : { body: bytesToBase64(new TextEncoder().encode(body)) }),
    cacheSettings: { store: false, maxAge: "0s" },
  }).result();
  if (response.statusCode !== 200) throw new Error(`source HTTP status ${response.statusCode}`);
  if (response.body.length > maxBytes) throw new Error(`source response exceeds ${maxBytes} bytes`);
  try { return JSON.parse(new TextDecoder().decode(response.body)); }
  catch { throw new Error("source response is not valid JSON"); }
}

export function fetchAkashEvidence(
  requester: HTTPSendRequester, url: string, terms: AkashTerms, nowSeconds: number, scope: AkashScope,
): string {
  snapshotTime(terms, nowSeconds, scope);
  return validateAkashResponse(fetchSource(requester, url), terms, nowSeconds, scope).canonicalEvidence;
}

function fetchObservation(requester: HTTPSendRequester, source: CompositeSource, terms: CompositeTerms): Observation {
  const { url, body, maxBytes } = sourceRequest(source, terms);
  const data = fetchSource(requester, url, { body, maxBytes });
  try { return extractSource(source, data, terms); }
  catch (error) { throw new Error(`invalid-response: ${error instanceof Error ? error.message : String(error)}`); }
}

// Each source reaches its own consensus on the extracted integer value and count (median), so one noisy source
// cannot sink the others; a source that errors or finds no consensus is recorded as failed in the evidence.
export function collectComposite(runtime: Runtime<Config>, terms: CompositeTerms, nowSeconds: number, scope: AkashScope): ValidatedMark {
  snapshotTime(terms, nowSeconds, scope);
  const results = {} as Record<CompositeSource, SourceResult>;
  for (const source of COMPOSITE_SOURCES) {
    try {
      const { value, count } = new HTTPClient().sendRequest(
        runtime, fetchObservation, ConsensusAggregationByFields<Observation>({ value: median, count: median }),
      )(source, terms).result();
      results[source] = { ok: true, value, count };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.log(`composite source ${source} failed: ${message}`);
      results[source] = { ok: false, reason: failureReason(message) };
    }
  }
  return compositeSnapshot(results, terms, nowSeconds, scope);
}

// One delimited line for the keeper to persist: the hash is keccak256 of exactly the bytes after the second space.
export function logEvidence(runtime: Runtime<Config>, { evidenceHash, canonicalEvidence }: ValidatedIndex): void {
  runtime.log(`PIRY_EVIDENCE ${evidenceHash} ${canonicalEvidence}`);
}

export function deliverReport(
  runtime: Runtime<Config>, config: Config, payload: Hex, receiver: string, gasLimit: string,
): string {
  const report = runtime.report(prepareReportRequest(payload)).result();
  const result = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chainName]).writeReport(runtime, {
    receiver, report, gasConfig: { gasLimit },
  }).result();
  const receiverStatus = result.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.SUCCESS
    ? "success" : result.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED
      ? "reverted" : "unknown";
  return deliveryOutcome(config.executionMode, result.txStatus === TxStatus.SUCCESS, receiverStatus);
}
