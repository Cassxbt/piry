import { Runner } from "@chainlink/cre-sdk";
import { configSchema, type Config } from "./config.js";
import { initWorkflow } from "./init.js";

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
