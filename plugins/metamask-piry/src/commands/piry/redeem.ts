import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { PiryCommand } from "../../base.js";
import { parseDecimal } from "../../math.js";
import { redeem, type RedeemResult } from "../../redeem.js";

const inputs = {
  minPayout: { type: InputFieldType.Text, flag: "min-payout", message: "Minimum USDC payout accepted (default: the exact previewed payout)", required: false, prompt: false },
  kuruMarket: { type: InputFieldType.Text, flag: "kuru-market", message: "Unused for redeeming; accepted for symmetry", required: false, prompt: false },
} satisfies InputSchema;

export default class PiryRedeem extends PiryCommand<RedeemResult> {
  static override description = "After settlement: withdraw claims from Kuru if needed and redeem them for USDC with a minimum-payout guard.";
  static override examples = ["<%= config.bin %> piry redeem", "<%= config.bin %> piry redeem --min-payout 80"];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "piry:redeem";

  async execute(io: CommandIO): Promise<RedeemResult> {
    return this.guard(async () => {
      const flags = await io.resolveInputs(inputs);
      const config = this.settings(flags.kuruMarket);
      return redeem(await this.deps(io, config), { minPayout: flags.minPayout ? parseDecimal(flags.minPayout, 6, "--min-payout") : null });
    });
  }

  override successHint(data: RedeemResult): string {
    return `Received ${data.receivedUsdc} USDC`;
  }
}
