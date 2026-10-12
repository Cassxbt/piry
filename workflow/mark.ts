import {
  HTTPClient, consensusIdenticalAggregation, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { configSchema, type Config } from "./config.js";
import { validateAkashEvidence } from "./akash.js";
import { deliverReport, fetchAkashEvidence, fetchSource } from "./onchain.js";
import { encodeMarkReport } from "./report.js";
import { validateMarkDataset } from "./validation.js";

type MarkConfig = NonNullable<Config["mark"]>;

export function fetchMarkEvidence(requester: HTTPSendRequester, config: Config, mark: MarkConfig, nowSeconds: number): string {
  const { terms } = config;
  if (terms.mode === "AKASH") return fetchAkashEvidence(requester, mark.sourceUrl, terms, nowSeconds, "mark");
  return validateMarkDataset(fetchSource(requester, mark.sourceUrl), terms, nowSeconds).canonicalEvidence;
}

export function onMark(runtime: Runtime<Config>): string {
  const config = configSchema.parse(runtime.config);
  const { mark } = config;
  if (!mark) throw new Error("mark handler is not configured");
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000);
  const evidence = new HTTPClient().sendRequest(
    runtime, fetchMarkEvidence, consensusIdenticalAggregation<string>(),
  )(config, mark, nowSeconds).result();
  const { terms } = config;
  const validated = terms.mode === "AKASH"
    ? validateAkashEvidence(evidence, terms, nowSeconds, "mark")
    : validateMarkDataset(JSON.parse(evidence).dataset, terms, nowSeconds);
  if (validated.canonicalEvidence !== evidence) throw new Error("consensus evidence is not canonical");
  const payload = encodeMarkReport(validated, terms, {
    feed: mark.feed as Address, chainId: BigInt(config.chainId),
  }, mark.observedAtMarginSeconds);
  const observedAt = validated.observedAt - mark.observedAtMarginSeconds;
  runtime.log(`${terms.mode} mark ${config.executionMode}: ${validated.methodology}; price=${validated.price}; slots=${validated.slots}; observedAt=${observedAt}; evidence=${validated.evidenceHash}; payload=${payload}`);
  const outcome = deliverReport(runtime, config, payload, mark.feed, mark.gasLimit);
  return `${terms.mode} mark: ${outcome}; ${validated.methodology}; price=${validated.price}; observedAt=${observedAt}; evidence=${validated.evidenceHash}`;
}
