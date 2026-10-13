import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { PiryCommand } from "../../base.js";
import { PiryError } from "../../errors.js";
import { parseDecimal, parsePositive, parseSlippageBps } from "../../math.js";
import { unwind, type UnwindMethod, type UnwindResult } from "../../unwind.js";

const inputs = {
  claims: { type: InputFieldType.Text, flag: "claims", message: "PIRY-L claims to unwind (default: all held)", required: false, prompt: false },
  method: { type: InputFieldType.Text, flag: "method", message: "auto, merge or sell (default auto: merge pairs first, sell the rest on Kuru)", required: false, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Slippage tolerance in basis points for a Kuru sale (default 100)", required: false, prompt: false },
  minProceeds: { type: InputFieldType.Text, flag: "min-proceeds", message: "Refuse to unwind for less than this many USDC in total (merge payout plus Kuru sale)", required: false, prompt: false },
  kuruMarket: { type: InputFieldType.Text, flag: "kuru-market", message: "Kuru order book for PIRY-L/USDC (defaults to PIRY_KURU_MARKET)", required: false, prompt: false },
} satisfies InputSchema;

const METHODS: readonly string[] = ["auto", "merge", "sell"];

export default class PiryUnwind extends PiryCommand<UnwindResult> {
  static override description = "Close a hedge before settlement: merge PIRY-L/PIRY-S pairs back into USDC, or sell PIRY-L on Kuru with a minimum-proceeds floor.";
  static override examples = ["<%= config.bin %> piry unwind", "<%= config.bin %> piry unwind --claims 100 --method sell --min-proceeds 40"];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "piry:unwind";

  async execute(io: CommandIO): Promise<UnwindResult> {
    return this.guard(async () => {
      const flags = await io.resolveInputs(inputs);
      const method = flags.method || "auto";
      if (!METHODS.includes(method)) throw new PiryError("INVALID_INPUT", `--method must be one of ${METHODS.join(", ")}, got "${method}".`, "Use auto, merge or sell.");
      const config = this.settings(flags.kuruMarket);
      return unwind(await this.deps(io, config), {
        claims: flags.claims ? parsePositive(flags.claims, 6, "--claims") : null,
        method: method as UnwindMethod,
        slippageBps: parseSlippageBps(flags.slippage || "100"),
        minProceeds: flags.minProceeds ? parseDecimal(flags.minProceeds, 6, "--min-proceeds") : null,
      });
    });
  }

  override successHint(data: UnwindResult): string {
    return data.next;
  }
}
