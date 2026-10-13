import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Hash } from "viem";
import { chain } from "../config";
import { useClient } from "./chain";
import { INPUTS_CHANGED, resolveWallet, StaleOperationError, useWalletPort, type ConnectedWallet } from "./wallet";

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

export interface Operation {
  // Switches the wallet to the app chain when needed and returns a client for the account the operation started with.
  wallet(): Promise<ConnectedWallet>;
  // Throws when the account, series or inputs changed since the click. Call it after every await and before each write.
  guard(): void;
}

const IDLE: ActionState = { phase: "idle" };

// Runs one operation: wallet prompt, confirmation, then refetch everything that may have changed. `identity` names
// what the result is about (owner, chain, series, market); `inputs` is what the user typed. A change in either
// aborts the operation before its next write, and a result is only shown while its identity is still on screen.
export function useAction(identity = "", inputs = "") {
  const pc = useClient();
  const queryClient = useQueryClient();
  const port = useWalletPort();
  const [stored, setStored] = useState<{ identity: string; state: ActionState }>({ identity, state: IDLE });
  const current = useRef({ identity, inputs });
  current.current = { identity, inputs };
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (label: string, send: (op: Operation) => Promise<Hash>): Promise<Hash | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      const start = current.current;
      const owner = port.account().address;
      const show = (state: ActionState) => setStored({ identity: start.identity, state });
      const op: Operation = {
        guard() {
          const liveOwner = port.account().address;
          if (!mounted.current || current.current.identity !== start.identity) throw new StaleOperationError();
          if (owner && liveOwner?.toLowerCase() !== owner.toLowerCase()) throw new StaleOperationError();
          if (current.current.inputs !== start.inputs) throw new StaleOperationError(INPUTS_CHANGED);
        },
        async wallet() {
          const wallet = await resolveWallet(port, chain.id, owner);
          op.guard();
          return wallet;
        },
      };
      show({ phase: "wallet", label });
      let hash: Hash | undefined;
      try {
        hash = await send(op);
        show({ phase: "pending", label, hash });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          show({ phase: "error", label, hash, message: "Transaction reverted on-chain" });
          return null;
        }
        show({ phase: "done", label, hash });
        void queryClient.invalidateQueries();
        return hash;
      } catch (error) {
        show({ phase: "error", label, message: describeError(error), hash });
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [pc, port, queryClient],
  );

  const reset = useCallback(() => setStored({ identity: current.current.identity, state: IDLE }), []);
  const state = stored.identity === identity ? stored.state : IDLE;
  const busy = stored.state.phase === "wallet" || stored.state.phase === "pending";
  return { state, run, reset, busy };
}
