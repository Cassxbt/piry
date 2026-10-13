import { PiryError } from "./errors.js";
import { StepFailed } from "./tx.js";

export interface Failure {
  code: string;
  message: string;
  hint: string;
}

const CHAIN_HINT =
  "MetaMask's gateway does not serve Monad testnet. Add chain 10143 with rpcTarget https://testnet-rpc.monad.xyz to customEvmChains in ~/.metamask/wallets.json (see the plugin README).";

const STALE_HINT = "Kuru's withdrawal limiter rejected a stale price. Wait a few minutes for it to refresh.";

const hostFields = (e: unknown): { code?: string; hint?: string; message: string } => {
  if (typeof e !== "object" || e === null) return { message: String(e) };
  const o = e as { code?: unknown; hint?: unknown; message?: unknown };
  return {
    code: typeof o.code === "string" ? o.code : undefined,
    hint: typeof o.hint === "string" && o.hint !== "" ? o.hint : undefined,
    message: typeof o.message === "string" ? o.message : String(e),
  };
}

const submitted = (error: StepFailed): string =>
  [...error.completed.map((s) => `${s.step} ${s.hash}`), ...(error.hash ? [`${error.step} ${error.hash}`] : [])].join(", ");

// Turns anything thrown inside a command into one error with a stable code. After a failed step the message lists every
// hash already submitted, because funds may sit in an intermediate place (for example the Kuru trading balance) and an
// UNCERTAIN transaction may still land. Dependent steps are never sent, and nothing is retried.
export function describeFailure(error: unknown): Failure {
  if (error instanceof PiryError) return { code: error.code, message: error.message, hint: error.hint };
  const stepFailure = error instanceof StepFailed ? error : null;
  const { code, hint, message } = hostFields(stepFailure ? stepFailure.cause : error);
  const stale = /0x393843a9|InvalidWithdrawalPrice/.test(message);
  const chainRpc = /Invalid chainId/i.test(message);

  if (!stepFailure) {
    if (stale) return { code: "PRICE_STALE", message, hint: STALE_HINT };
    if (chainRpc) return { code: "MM_CHAIN_RPC_UNAVAILABLE", message, hint: `${CHAIN_HINT} Then retry.` };
    return { code: code ?? "PIRY_ERROR", message, hint: hint ?? "Check `mm piry position`, then retry only if nothing was sent." };
  }

  const hashes = submitted(stepFailure);
  const after = stepFailure.completed.length > 0 ? ` after ${stepFailure.completed.map((s) => `${s.step} (${s.hash})`).join(", ")}` : "";
  const verb = stepFailure.outcome === "FAILED" ? "failed" : "could not be confirmed";
  const text = `${stepFailure.outcome}: step "${stepFailure.step}" ${verb}${after}: ${message}${/[.!?]$/.test(message) ? "" : "."} ${hashes ? `Submitted hashes: ${hashes}.` : "No transaction hash was returned."} Later steps were not sent.`;
  const next = stepFailure.outcome === "UNCERTAIN"
    ? "The transaction may still land. Do not retry or resubmit: check each hash on the explorer and run `mm piry position`, and act only once it is confirmed or dropped."
    : "Do not retry blindly. Run `mm piry position` to see where your funds are, then preview again before any new write.";
  if (stale) return { code: "PRICE_STALE", message: text, hint: `${STALE_HINT} ${next}` };
  if (chainRpc) return { code: "MM_CHAIN_RPC_UNAVAILABLE", message: text, hint: `${CHAIN_HINT} ${next}` };
  return {
    code: stepFailure.outcome === "UNCERTAIN" ? "TRANSACTION_UNCERTAIN" : code ?? "TRANSACTION_FAILED",
    message: text,
    hint: `${hint ? `${hint} ` : ""}${next}`,
  };
}
