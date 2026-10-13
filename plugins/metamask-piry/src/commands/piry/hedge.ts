import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { getAddress, isAddress } from "viem";
import { PiryCommand } from "../../base.js";
import { PiryError } from "../../errors.js";
import { hedge, type HedgeResult } from "../../hedge.js";
import { GPU_HOURS_DECIMALS, parseDecimal, parsePositive, parseSlippageBps } from "../../math.js";

const inputs = {
  gpuHours: { type: InputFieldType.Text, flag: "gpu-hours", message: "Total GPU-hours of compute to hedge", required: true, prompt: false },
  maxPremium: { type: InputFieldType.Text, flag: "max-premium", message: "Most USDC you will pay. Without it, nothing is sent and a preview is returned", required: false, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Slippage tolerance in basis points (default 100 = 1%)", required: false, prompt: false },
  allowMint: { type: InputFieldType.Boolean, flag: "allow-mint", message: "If Kuru has no PIRY-L market, mint claim pairs instead (locks 1 USDC per claim)", required: false, prompt: false, default: false },
  shortTo: { type: InputFieldType.Text, flag: "short-to", message: "With --allow-mint: address that receives the PIRY-S leg", required: false, prompt: false },
  kuruMarket: { type: InputFieldType.Text, flag: "kuru-market", message: "Kuru order book for PIRY-L/USDC (defaults to PIRY_KURU_MARKET)", required: false, prompt: false },
  kuruShortMarket: { type: InputFieldType.Text, flag: "kuru-short-market", message: "Kuru order book for PIRY-S/USDC, used to sell the short leg when minting (defaults to PIRY_KURU_SHORT_MARKET)", required: false, prompt: false },
} satisfies InputSchema;

export default class PiryHedge extends PiryCommand<HedgeResult> {
  static override description =
    "Hedge GPU-hours by buying PIRY-L on Kuru within a spending cap. Previews unless --max-premium is given; every transaction goes through the Agent Wallet.";
  static override examples = [
    "<%= config.bin %> piry hedge --gpu-hours 500",
    "<%= config.bin %> piry hedge --gpu-hours 500 --max-premium 150 --slippage 100",
    "<%= config.bin %> piry hedge --gpu-hours 500 --max-premium 1000 --allow-mint",
  ];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "piry:hedge";

  async execute(io: CommandIO): Promise<HedgeResult> {
    return this.guard(async () => {
      const flags = await io.resolveInputs(inputs);
      const config = this.settings(flags.kuruMarket, flags.kuruShortMarket);
      const deps = await this.deps(io, config);
      if (flags.shortTo && !flags.allowMint) throw new PiryError("INVALID_INPUT", "--short-to only applies together with --allow-mint.", "Add --allow-mint or drop --short-to.");
      if (flags.shortTo && !isAddress(flags.shortTo)) throw new PiryError("INVALID_ADDRESS", `--short-to is not a valid address: ${flags.shortTo}`, "Pass a 0x address.");
      const shortTo = flags.shortTo ? getAddress(flags.shortTo) : null;
      if (shortTo === deps.wallet.address) throw new PiryError("INVALID_INPUT", "--short-to is your own address, which would leave the hedge inactive.", "Pass a different counterparty address.");
      return hedge(deps, {
        gpuHoursMicro: parsePositive(flags.gpuHours, GPU_HOURS_DECIMALS, "--gpu-hours"),
        maxPremium: flags.maxPremium ? parseDecimal(flags.maxPremium, 6, "--max-premium") : null,
        slippageBps: parseSlippageBps(flags.slippage || "100"),
        allowMint: flags.allowMint,
        shortTo,
      });
    });
  }

  override successHint(data: HedgeResult): string {
    return `${data.status} via ${data.path}: ${data.next}`;
  }
}
