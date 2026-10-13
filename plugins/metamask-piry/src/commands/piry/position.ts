import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { getAddress, isAddress } from "viem";
import { PiryCommand } from "../../base.js";
import { PiryError } from "../../errors.js";
import { position, type PositionResult } from "../../position.js";
import { activeAddress } from "../../wallet.js";

const inputs = {
  owner: { type: InputFieldType.Text, flag: "owner", message: "Address to inspect (defaults to the Agent Wallet's active wallet)", required: false, prompt: false },
} satisfies InputSchema;

export default class PiryPosition extends PiryCommand<PositionResult> {
  static override description = "Show Piry claims held (wallet and Kuru trading balance), their mark value, and the settlement status. Read-only.";
  static override examples = ["<%= config.bin %> piry position", "<%= config.bin %> piry position --owner 0x... --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "piry:position";

  async execute(io: CommandIO): Promise<PositionResult> {
    return this.guard(async () => {
      const { owner } = await io.resolveInputs(inputs);
      if (owner && !isAddress(owner)) throw new PiryError("INVALID_ADDRESS", `--owner is not a valid address: ${owner}`, "Pass a 0x address.");
      const address = owner ? getAddress(owner) : activeAddress(this.ctx.walletStateManager.read());
      const config = this.settings();
      return position(this.reader(config), config, address);
    });
  }

  override successHint(data: PositionResult): string {
    return `${data.series.status}: net long ${data.claims.netLong} claims covering ${data.claims.coveredGpuHours} GPU-hours`;
  }
}
