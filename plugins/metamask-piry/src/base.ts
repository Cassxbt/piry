import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import type { Reader } from "./chain.js";
import { resolveConfig, type Config } from "./config.js";
import type { Deps } from "./context.js";
import { describeFailure } from "./failure.js";
import { makeReader } from "./reader.js";
import { activeAddress, adaptExecutor, type HostExecutor } from "./wallet.js";

export abstract class PiryCommand<T> extends PluginCommand<T> {
  protected settings(kuruMarket?: string, kuruShortMarket?: string): Config {
    return resolveConfig({ kuruMarket, kuruShortMarket, env: process.env });
  }

  // Every failure leaves the command as one CommandError with a stable code and a next step.
  protected async guard<R>(work: () => Promise<R>): Promise<R> {
    try {
      return await work();
    } catch (error) {
      const failure = describeFailure(error);
      throw new CommandError(failure.code, failure.message, failure.hint);
    }
  }

  protected reader(config: Config): Reader {
    return makeReader(config.rpcUrl);
  }

  // The only write path: the host's wallet executor, which applies MetaMask policy, threat scanning and 2FA.
  protected async deps(io: CommandIO, config: Config): Promise<Deps> {
    const address = activeAddress(this.ctx.walletStateManager.read());
    const execute = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const wallet = adaptExecutor(address, execute as HostExecutor, io.signal);
    return { client: this.reader(config), config, wallet, note: (line) => io.emit(line) };
  }
}
