import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Hash } from "viem";
import { useClient } from "./chain";

export type ActionState =
  | { phase: "idle" }
  | { phase: "wallet"; label: string }
  | { phase: "pending"; label: string; hash: Hash }
  | { phase: "done"; label: string; hash: Hash }
  | { phase: "error"; label: string; message: string; hash?: Hash };

// Kuru's withdrawal limiter reverts InvalidWithdrawalPrice when the token's feed updatedAt is older than 1800 s.
export const INVALID_WITHDRAWAL_PRICE = "0x393843a9";
const STALE_PRICE_MESSAGE = "Kuru's price check needs a fresh mark (under 30 min); the keeper refreshes it every few minutes, try again shortly";

function mentions(error: unknown, needle: string): boolean {
  const seen = new Set<unknown>();
  for (let e = error as { cause?: unknown } | undefined; e && typeof e === "object" && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    const { message, details, data } = e as { message?: unknown; details?: unknown; data?: unknown };
    for (const field of [message, details, data]) if (typeof field === "string" && field.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function describeError(error: unknown): string {
  if (mentions(error, INVALID_WITHDRAWAL_PRICE) || mentions(error, "invalidwithdrawalprice")) return STALE_PRICE_MESSAGE;
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ? `Contract refused: ${reverted.data.errorName}` : reverted.shortMessage;
    }
    if (error.walk((e) => (e as { code?: number }).code === 4001)) return "Rejected in wallet";
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

// Runs one transaction: wallet prompt, confirmation, then refetch everything that may have changed.
export function useAction() {
  const pc = useClient();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ActionState>({ phase: "idle" });

  const run = useCallback(
    async (label: string, send: () => Promise<Hash>): Promise<Hash | null> => {
      setState({ phase: "wallet", label });
      let hash: Hash | undefined;
      try {
        hash = await send();
        setState({ phase: "pending", label, hash });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setState({ phase: "error", label, hash, message: "Transaction reverted on-chain" });
          return null;
        }
        setState({ phase: "done", label, hash });
        void queryClient.invalidateQueries();
        return hash;
      } catch (error) {
        setState({ phase: "error", label, message: describeError(error), hash });
        return null;
      }
    },
    [pc, queryClient],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset, busy: state.phase === "wallet" || state.phase === "pending" };
}
