import { parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";
import { computeMarketAbi, markFeedAbi, settlementReceiverAbi, simulationReceiverAbi } from "../abi";
import { fetchText } from "./evidence";
import { boundTo, reportProcessedEvent, type LedgerContext } from "./ledger";

export interface LifecycleStep {
  step: string;
  tx: Hex | null;
}

// The run log is a list of claims. Only its transaction hashes are used as pointers; outcomes come from receipts.
export async function loadLifecycle(base: string, market: string): Promise<LifecycleStep[] | null> {
  const text = await fetchText(`${base}/lifecycle.json`);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { contracts?: { market?: string }; steps?: { step?: string; tx?: string }[] };
    if (!Array.isArray(parsed.steps) || !boundTo(parsed.contracts?.market ?? null, market)) return null;
    return parsed.steps.flatMap((s) =>
      s.step ? [{ step: s.step, tx: s.tx && /^0x[0-9a-fA-F]{64}$/.test(s.tx) ? (s.tx as Hex) : null }] : [],
    );
  } catch {
    return null;
  }
}

export interface Redemption {
  long: bigint;
  short: bigint;
  payout: bigint;
  recipient: Address;
}

export interface StepProof {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  timestamp: bigint;
  events: string[];
  redemptions: Redemption[];
  forwarderResult: boolean | null;
}

export async function proveTransaction(pc: PublicClient, ctx: LedgerContext, hash: Hex): Promise<StepProof> {
  const receipt = await pc.getTransactionReceipt({ hash });
  const block = await pc.getBlock({ blockNumber: receipt.blockNumber });
  const at = (log: Log, address: Address | null) => address !== null && log.address.toLowerCase() === address.toLowerCase();
  const events: string[] = [];
  const redemptions: Redemption[] = [];
  let forwarderResult: boolean | null = null;

  for (const log of receipt.logs) {
    if (at(log, ctx.forwarder)) {
      const p = parseEventLogs({ abi: [reportProcessedEvent], logs: [log], strict: false })[0];
      if (p) {
        forwarderResult = p.args.result ?? null;
        events.push(`ReportProcessed(result=${String(p.args.result)})`);
      }
    } else if (at(log, ctx.market)) {
      for (const e of parseEventLogs({ abi: computeMarketAbi, logs: [log], strict: false })) {
        events.push(e.eventName as string);
        if (e.eventName === "Redeemed") {
          const a = e.args as { longAmount: bigint; shortAmount: bigint; payout: bigint; recipient: Address };
          redemptions.push({ long: a.longAmount, short: a.shortAmount, payout: a.payout, recipient: a.recipient });
        }
      }
    } else if (at(log, ctx.feed)) {
      for (const e of parseEventLogs({ abi: markFeedAbi, logs: [log], strict: false })) events.push(e.eventName as string);
    } else if (at(log, ctx.settlementReceiver)) {
      for (const e of parseEventLogs({ abi: [...settlementReceiverAbi, ...simulationReceiverAbi], logs: [log], strict: false })) events.push(e.eventName as string);
    }
  }
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber, timestamp: block.timestamp, events, redemptions, forwarderResult };
}
