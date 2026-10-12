import {
  EVMClient, HTTPClient, TxStatus, consensusIdenticalAggregation,
  prepareReportRequest, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import type { Address } from "viem";
import { configSchema, type Config } from "./config.js";
import { encodeMarketReport } from "./report.js";
import { MAX_RESPONSE_BYTES, validateDataset } from "./validation.js";
import { deliveryOutcome } from "./delivery.js";

export function fetchObservationEvidence(requester: HTTPSendRequester, config: Config, nowSeconds: number): string {
  const response = requester.sendRequest({
    url: config.sourceUrl, method: "GET", timeout: "5s",
    multiHeaders: { Accept: { values: ["application/json"] } },
    cacheSettings: { store: false, maxAge: "0s" },
  }).result();
  if (response.statusCode !== 200) throw new Error(`source HTTP status ${response.statusCode}`);
  if (response.body.length > MAX_RESPONSE_BYTES) throw new Error("source response exceeds 64 KiB");
  const data: unknown = JSON.parse(new TextDecoder().decode(response.body));
  return validateDataset(data, config.terms, nowSeconds).canonicalEvidence;
}

export function onSettlement(runtime: Runtime<Config>): string {
  const config = configSchema.parse(runtime.config);
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000);
  const evidence = new HTTPClient().sendRequest(
    runtime, fetchObservationEvidence, consensusIdenticalAggregation<string>(),
  )(config, nowSeconds).result();
  const validated = validateDataset(JSON.parse(evidence).dataset, config.terms, nowSeconds);
  if (validated.canonicalEvidence !== evidence) throw new Error("consensus evidence is not canonical");
  const payload = encodeMarketReport(validated, config.terms, {
    market: config.market as Address, chainId: BigInt(config.chainId),
  });
  runtime.log(`DEMO ${config.executionMode}: price=${validated.price}; evidence=${validated.evidenceHash}; payload=${payload}`);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const result = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chainName]).writeReport(runtime, {
    receiver: config.receiver, report, gasConfig: { gasLimit: config.gasLimit },
  }).result();
  const receiverStatus = result.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.SUCCESS
    ? "success" : result.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED
      ? "reverted" : "unknown";
  return `DEMO: ${deliveryOutcome(config.executionMode, result.txStatus === TxStatus.SUCCESS, receiverStatus)}; evidence=${validated.evidenceHash}`;
}
