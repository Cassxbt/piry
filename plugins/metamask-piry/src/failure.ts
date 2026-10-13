import { PiryError } from "./errors.js";
import { StepFailed } from "./tx.js";

export interface Failure {
  code: string;
  message: string;
  hint: string;
}

const CHAIN_HINT =
  "MetaMask's gateway does not serve Monad testnet. Add chain 10143 with rpcTarget https://testnet-rpc.monad.xyz to customEvmChains in ~/.metamask/wallets.json (see the plugin README), then retry.";

const hostFields = (e: unknown): { code?: string; hint?: string; message: string } => {
  if (typeof e !== "object" || e === null) return { message: String(e) };
  const o = e as { code?: unknown; hint?: unknown; message?: unknown };
  return {
    code: typeof o.code === "string" ? o.code : undefined,
    hint: typeof o.hint === "string" && o.hint !== "" ? o.hint : undefined,
    message: typeof o.message === "string" ? o.message : String(e),
  };
}

// Turns anything thrown inside a command into one error with a stable code. After a failed step the message says
// which steps already landed, because funds may sit in an intermediate place (for example the Kuru trading balance).
export function describeFailure(error: unknown): Failure {
  if (error instanceof PiryError) return { code: error.code, message: error.message, hint: error.hint };
  const inner = error instanceof StepFailed ? error.cause : error;
  const { code, hint, message } = hostFields(inner);
  const prefix = error instanceof StepFailed
    ? `Step "${error.step}" failed${error.completed.length > 0 ? ` after ${error.completed.map((s) => `${s.step} (${s.hash})`).join(", ")}` : ""}: `
    : "";
  const completed = error instanceof StepFailed && error.completed.length > 0
    ? " Earlier steps already landed on chain; run `mm piry position` to see where your funds are and do not blindly retry."
    : "";
  if (/0x393843a9|InvalidWithdrawalPrice/.test(message)) {
    return { code: "PRICE_STALE", message: `${prefix}${message}`, hint: "Kuru's withdrawal limiter rejected a stale price. Wait a few minutes for it to refresh, check `mm piry position`, then retry." + completed };
  }
  if (/Invalid chainId/i.test(message)) {
    return { code: "MM_CHAIN_RPC_UNAVAILABLE", message: `${prefix}${message}`, hint: CHAIN_HINT + completed };
  }
  return {
    code: code ?? (error instanceof StepFailed ? "TRANSACTION_FAILED" : "PIRY_ERROR"),
    message: `${prefix}${message}`,
    hint: (hint ?? "Check `mm piry position`, then retry only if nothing was sent.") + completed,
  };
}
