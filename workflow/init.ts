import { CronCapability, handler } from "@chainlink/cre-sdk";
import type { Config } from "./config.js";
import { onMark } from "./mark.js";
import { onSettlement } from "./settlement.js";

// Trigger index 0 settles, index 1 publishes the period-to-date mark; the mark handler exists only when configured.
export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onSettlement),
  ...(config.mark ? [handler(new CronCapability().trigger({ schedule: config.mark.schedule }), onMark)] : []),
];
