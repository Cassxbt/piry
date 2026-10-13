import { useQuery } from "@tanstack/react-query";
import { chain } from "../config";
import type { SeriesSubject } from "../config/types";
import { loadLifecycle, proveTransaction, type LifecycleStep, type StepProof } from "../lib/lifecycle";
import type { LedgerContext } from "../lib/ledger";
import type { MarketSnapshot } from "../lib/reads";
import { useClient } from "./chain";

export interface LifecycleData {
  steps: { step: LifecycleStep; proof: StepProof | null }[];
}

export function useLifecycle(snapshot: MarketSnapshot | undefined, subject: SeriesSubject) {
  const pc = useClient();
  return useQuery({
    queryKey: ["lifecycle", subject.evidenceBase, snapshot?.address],
    queryFn: async (): Promise<LifecycleData | null> => {
      const steps = snapshot ? await loadLifecycle(subject.evidenceBase, snapshot.address) : null;
      if (!steps || !snapshot) return null;
      const ctx: LedgerContext = {
        forwarder: subject.contracts.forwarder as `0x${string}`,
        market: snapshot.address,
        settlementReceiver: subject.contracts.receiver,
        feed: subject.contracts.markFeed,
        chainId: BigInt(chain.id),
      };
      const proofs = await Promise.all(steps.map((s) => (s.tx && subject.contracts.forwarder ? proveTransaction(pc, ctx, s.tx).catch(() => null) : null)));
      return { steps: steps.map((step, i) => ({ step, proof: proofs[i] ?? null })) };
    },
    enabled: snapshot !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}
