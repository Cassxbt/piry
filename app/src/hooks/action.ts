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

export function describeError(error: unknown): string {
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
