import {
  EVMClient, TxStatus, prepareReportRequest, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import type { Hex } from "viem";
import type { Config } from "./config.js";
import { deliveryOutcome } from "./delivery.js";
import { MAX_RESPONSE_BYTES } from "./validation.js";

export function fetchSource(requester: HTTPSendRequester, url: string): unknown {
  const response = requester.sendRequest({
    url, method: "GET", timeout: "5s",
    multiHeaders: { Accept: { values: ["application/json"] } },
    cacheSettings: { store: false, maxAge: "0s" },
  }).result();
  if (response.statusCode !== 200) throw new Error(`source HTTP status ${response.statusCode}`);
  if (response.body.length > MAX_RESPONSE_BYTES) throw new Error("source response exceeds 64 KiB");
  return JSON.parse(new TextDecoder().decode(response.body));
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
