import { useQuery } from "@tanstack/react-query";
import { chain, config } from "../config";
import { loadLifecycle, proveTransaction, type LifecycleStep, type StepProof } from "../lib/lifecycle";
import type { LedgerContext } from "../lib/ledger";
import type { MarketSnapshot } from "../lib/reads";
import { useClient } from "./chain";

export interface LifecycleData {
  steps: { step: LifecycleStep; proof: StepProof | null }[];
}

export function useLifecycle(snapshot: MarketSnapshot | undefined) {
  const pc = useClient();
  return useQuery({
    queryKey: ["lifecycle", config.evidenceBase, snapshot?.address],
    queryFn: async (): Promise<LifecycleData | null> => {
      const steps = await loadLifecycle(config.evidenceBase);
      if (!steps || !snapshot) return null;
      const ctx: LedgerContext = {
        forwarder: config.contracts.forwarder as `0x${string}`,
        market: snapshot.address,
        settlementReceiver: config.contracts.receiver,
        feed: config.contracts.markFeed,
        chainId: BigInt(chain.id),
      };
      const proofs = await Promise.all(steps.map((s) => (s.tx && config.contracts.forwarder ? proveTransaction(pc, ctx, s.tx).catch(() => null) : null)));
      return { steps: steps.map((step, i) => ({ step, proof: proofs[i] ?? null })) };
    },
    enabled: snapshot !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}
