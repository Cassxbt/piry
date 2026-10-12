import {
  HTTPClient, consensusIdenticalAggregation, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { configSchema, type Config } from "./config.js";
import { deliverReport, fetchSource } from "./onchain.js";
import { encodeMarketReport } from "./report.js";
import { validateDataset } from "./validation.js";

export function fetchObservationEvidence(requester: HTTPSendRequester, config: Config, nowSeconds: number): string {
  return validateDataset(fetchSource(requester, config.sourceUrl), config.terms, nowSeconds).canonicalEvidence;
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
  const outcome = deliverReport(runtime, config, payload, config.receiver, config.gasLimit);
  return `DEMO: ${outcome}; evidence=${validated.evidenceHash}`;
}
