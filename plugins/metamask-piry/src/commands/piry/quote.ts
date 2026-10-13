import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { PiryCommand } from "../../base.js";
import { GPU_HOURS_DECIMALS, parsePositive } from "../../math.js";
import { quote, type QuoteResult } from "../../quote.js";
import { fetchComposite, type Composite } from "../../sources.js";

const inputs = {
  gpuHours: { type: InputFieldType.Text, flag: "gpu-hours", message: "GPU-hours of compute to size a hedge for", required: false, prompt: false },
  kuruMarket: { type: InputFieldType.Text, flag: "kuru-market", message: "Kuru order book for PIRY-L/USDC (defaults to PIRY_KURU_MARKET)", required: false, prompt: false },
  sources: { type: InputFieldType.Boolean, flag: "sources", message: "Also read the four public price sources live", required: false, prompt: false, default: false },
} satisfies InputSchema;

type QuoteOutput = QuoteResult & { liveSources?: Composite };

export default class PiryQuote extends PiryCommand<QuoteOutput> {
  static override description = "Show the live Piry H100 index, the hedge band and how many claims hedge a number of GPU-hours. Read-only.";
  static override examples = [
    "<%= config.bin %> piry quote",
    "<%= config.bin %> piry quote --gpu-hours 500 --json",
    "<%= config.bin %> piry quote --gpu-hours 500 --sources",
  ];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "piry:quote";

  async execute(io: CommandIO): Promise<QuoteOutput> {
    return this.guard(async () => {
      const flags = await io.resolveInputs(inputs);
      const config = this.settings(flags.kuruMarket);
      const hours = flags.gpuHours ? parsePositive(flags.gpuHours, GPU_HOURS_DECIMALS, "--gpu-hours") : null;
      const [result, liveSources] = await Promise.all([quote(this.reader(config), config, hours), flags.sources ? fetchComposite() : Promise.resolve(undefined)]);
      return liveSources ? { ...result, liveSources } : result;
    });
  }

  override successHint(data: QuoteOutput): string {
    const index = data.index.usdPerGpuHour ? `last on-chain mark $${data.index.usdPerGpuHour}/GPU-hour` : "no on-chain mark yet";
    return `PREVIEW: ${index}, band $${data.band.lowerUsd}-$${data.band.upperUsd}, ${data.settlement.status}`;
  }
}
