import {
  HTTPClient, consensusIdenticalAggregation, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { configSchema, type Config } from "./config.js";
import { validateAkashEvidence } from "./akash.js";
import { deliverReport, fetchAkashEvidence, fetchSource } from "./onchain.js";
import { encodeMarketReport } from "./report.js";
import { validateDataset } from "./validation.js";

export function fetchObservationEvidence(requester: HTTPSendRequester, config: Config, nowSeconds: number): string {
  const { terms } = config;
  if (terms.mode === "AKASH") return fetchAkashEvidence(requester, config.sourceUrl, terms, nowSeconds, "settlement");
  return validateDataset(fetchSource(requester, config.sourceUrl), terms, nowSeconds).canonicalEvidence;
}

export function onSettlement(runtime: Runtime<Config>): string {
  const config = configSchema.parse(runtime.config);
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000);
  const evidence = new HTTPClient().sendRequest(
    runtime, fetchObservationEvidence, consensusIdenticalAggregation<string>(),
  )(config, nowSeconds).result();
  const { terms } = config;
  const validated = terms.mode === "AKASH"
    ? validateAkashEvidence(evidence, terms, nowSeconds, "settlement")
    : validateDataset(JSON.parse(evidence).dataset, terms, nowSeconds);
  if (validated.canonicalEvidence !== evidence) throw new Error("consensus evidence is not canonical");
  const payload = encodeMarketReport(validated, terms, {
    market: config.market as Address, chainId: BigInt(config.chainId),
  });
  runtime.log(`${terms.mode} ${config.executionMode}: price=${validated.price}; evidence=${validated.evidenceHash}; payload=${payload}`);
  const outcome = deliverReport(runtime, config, payload, config.receiver, config.gasLimit);
  return `${terms.mode}: ${outcome}; evidence=${validated.evidenceHash}`;
}
