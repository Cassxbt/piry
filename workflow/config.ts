import { z } from "zod";
import { isAddress, zeroAddress } from "viem";
import { validateTerms } from "./validation.js";

const address = z.string().refine(value => isAddress(value) && value.toLowerCase() !== zeroAddress, "nonzero EVM address required");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceUrl = z.string().max(2048);
const schedule = z.string().min(1).max(80);
const gasLimit = z.string().regex(/^[1-9][0-9]{0,7}$/);
export const configSchema = z.object({
  executionMode: z.enum(["simulation", "authenticated"]),
  sourceUrl,
  schedule,
  chainName: z.enum(["monad-testnet", "monad-mainnet"]),
  chainId: z.enum(["10143", "143"]),
  receiver: address,
  market: address,
  gasLimit,
  mark: z.object({ feed: address, sourceUrl, schedule, gasLimit, observedAtMarginSeconds: z.number().int().min(0).max(600) }).strict().optional(),
  terms: z.object({
    mode: z.literal("DEMO"), sourceId: z.string(), datasetId: z.string(),
    hardware: z.object({ model: z.string(), memoryGiB: integer, gpuCount: integer, region: z.string() }).strict(),
    currency: z.literal("USD"), units: z.literal("USD/GPU-hour"), priceDecimals: integer,
    slotSeconds: integer, periodStart: integer, periodEnd: integer, maxPublicationAgeSeconds: integer,
  }).strict(),
}).strict().superRefine((config, context) => {
  for (const url of [config.sourceUrl, ...(config.mark ? [config.mark.sourceUrl] : [])]) {
    const localHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?\//.test(url);
    const publicHttps = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?\//.test(url);
    if (!publicHttps && !(config.executionMode === "simulation" && localHttp)) {
      context.addIssue({ code: "custom", message: "source must use HTTPS; localhost HTTP only in simulation" });
    }
  }
  if (config.chainId !== (config.chainName === "monad-testnet" ? "10143" : "143")) {
    context.addIssue({ code: "custom", message: "chain name / chain ID binding mismatch" });
  }
  try { validateTerms(config.terms); }
  catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});

export type Config = z.infer<typeof configSchema>;
