import { CronCapability, Runner, handler } from "@chainlink/cre-sdk";
import { configSchema, type Config } from "./config.js";
import { onSettlement } from "./settlement.js";

const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onSettlement),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
