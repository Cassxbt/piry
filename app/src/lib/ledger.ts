import {
  decodeAbiParameters, decodeErrorResult, decodeFunctionData, hexToBytes, bytesToHex, parseAbi, parseAbiItem, parseEventLogs,
  type Address, type Hex, type Log, type PublicClient,
} from "viem";
import { computeMarketAbi, markFeedAbi, settlementReceiverAbi, simulationReceiverAbi } from "../abi";
import { fetchText } from "./evidence";
import { diagnoseMark, diagnoseSettlement, type Diagnosis, type MarkReport, type SettlementReport } from "./diagnose";
import { SCAN_CONCURRENCY } from "./rateLimit";
import type { MarketSnapshot } from "./reads";

// Chainlink's KeystoneForwarder (and its mock) emit this for every delivery. result is false when the
// receiver reverted, even though the outer transaction succeeds.
export const reportProcessedEvent = parseAbiItem(
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
);
const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);

// rawReport = 109-byte header (version, execution id, timestamp, DON id, config version, workflow id, name,
// owner, report id) followed by the payload handed to onReport.
const RAW_REPORT_HEADER = 109;

const settlementParams = [{
  type: "tuple",
  components: [
    { name: "market", type: "address" }, { name: "chainId", type: "uint256" }, { name: "indexId", type: "bytes32" },
    { name: "specHash", type: "bytes32" }, { name: "priceDecimals", type: "uint8" }, { name: "periodStart", type: "uint64" },
    { name: "periodEnd", type: "uint64" }, { name: "price", type: "uint256" }, { name: "publishedAt", type: "uint64" },
    { name: "evidenceHash", type: "bytes32" },
  ],
}] as const;
const markParams = [{
  type: "tuple",
  components: [
    { name: "feed", type: "address" }, { name: "chainId", type: "uint256" }, { name: "indexId", type: "bytes32" },
    { name: "indexPrice", type: "uint256" }, { name: "observedAt", type: "uint64" }, { name: "evidenceHash", type: "bytes32" },
  ],
}] as const;

const errorAbi = [...computeMarketAbi, ...settlementReceiverAbi, ...simulationReceiverAbi, ...markFeedAbi].filter((i) => i.type === "error");

export interface LedgerContext {
  forwarder: Address;
  market: Address;
  settlementReceiver: Address | null;
  feed: Address | null;
  chainId: bigint;
}

export interface SettlementPoint {
  blockNumber: bigint;
  transactionIndex: number;
}

export interface LedgerEnv {
  snapshot: MarketSnapshot;
  settlementAt: SettlementPoint | null;
  operators: { settlement: Address | null; mark: Address | null };
}

export type DeliveryOutcome = "settled" | "mark-accepted" | "refused" | "reverted" | "unconfirmed";

export interface Delivery {
  txHash: Hex;
  blockNumber: bigint;
  transactionIndex: number;
  timestamp: bigint;
  sender: Address;
  target: "settlement" | "mark";
  receiver: Address;
  outcome: DeliveryOutcome;
  forwarderResult: boolean | null;
  events: string[];
  settlement: SettlementReport | null;
  mark: MarkReport | null;
  diagnosis: Diagnosis | null;
  trace: RevertTrace | null;
  note: string | null;
}

function payloadOf(input: Hex): Hex | null {
  try {
    const { args } = decodeFunctionData({ abi: forwarderAbi, data: input });
    const raw = hexToBytes(args[1]);
    return raw.length >= RAW_REPORT_HEADER ? bytesToHex(raw.slice(RAW_REPORT_HEADER)) : null;
  } catch {
    return null;
  }
}

function decodeSettlement(payload: Hex | null): SettlementReport | null {
  if (!payload || hexToBytes(payload).length !== 320) return null;
  try {
    return decodeAbiParameters(settlementParams, payload)[0] as SettlementReport;
  } catch {
    return null;
  }
}

function decodeMark(payload: Hex | null): MarkReport | null {
  if (!payload || hexToBytes(payload).length !== 192) return null;
  try {
    return decodeAbiParameters(markParams, payload)[0] as MarkReport;
  } catch {
    return null;
  }
}

type CallFrame = { to?: string; error?: string; output?: Hex; calls?: CallFrame[] };

export interface RevertTrace {
  errorName: string | null;
  message: string | null;
}

// Where the node exposes debug_traceTransaction (Anvil does, most public RPCs do not), read how the receiver
// call actually ended. Anything else falls back to the reconstruction in diagnose.ts.
async function traceRevert(pc: PublicClient, hash: Hex, receiver: Address): Promise<RevertTrace | null> {
  try {
    const request = (pc as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request;
    const root = (await request({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] })) as CallFrame;
    const find = (frame: CallFrame): CallFrame | null => {
      if (frame.to?.toLowerCase() === receiver.toLowerCase() && frame.error) return frame;
      for (const child of frame.calls ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const frame = find(root);
    if (!frame) return null;
    const deepest = (f: CallFrame): CallFrame => (f.calls ?? []).map((c) => (c.error ? deepest(c) : null)).find((c): c is CallFrame => c !== null) ?? f;
    const inner = deepest(frame);
    let errorName: string | null = null;
    for (const candidate of [frame, inner]) {
      if (errorName === null && candidate.output && candidate.output.length >= 10) {
        try { errorName = decodeErrorResult({ abi: errorAbi, data: candidate.output }).errorName; } catch { /* not one of ours */ }
      }
    }
    return { errorName, message: errorName ? null : inner.error ?? frame.error ?? null };
  } catch {
    return null;
  }
}

export async function readDelivery(pc: PublicClient, ctx: LedgerContext, txHash: Hex, note: string | null = null): Promise<Delivery | null> {
  const [tx, receipt] = await Promise.all([pc.getTransaction({ hash: txHash }), pc.getTransactionReceipt({ hash: txHash })]);
  const block = await pc.getBlock({ blockNumber: receipt.blockNumber });

  const processed = parseEventLogs({ abi: [reportProcessedEvent], logs: receipt.logs, strict: false })
    .filter((log) => log.address.toLowerCase() === ctx.forwarder.toLowerCase());
  const targets = [ctx.settlementReceiver, ctx.feed].filter((a): a is Address => a !== null).map((a) => a.toLowerCase());
  const hit = processed.find((log) => targets.includes((log.args.receiver ?? "").toLowerCase()));
  const receiverAddress = hit?.args.receiver ?? (tx.input.length > 10 ? safeReceiver(tx.input) : null);
  if (!receiverAddress || !targets.includes(receiverAddress.toLowerCase())) return null;

  const target = receiverAddress.toLowerCase() === ctx.settlementReceiver?.toLowerCase() ? "settlement" : "mark";
  const events = receipt.logs.flatMap((log: Log): string[] => {
    const a = log.address.toLowerCase();
    if (a === ctx.forwarder.toLowerCase()) {
      const p = parseEventLogs({ abi: [reportProcessedEvent], logs: [log], strict: false })[0];
      return p ? [`ReportProcessed(result=${String(p.args.result)})`] : [];
    }
    const abi = a === ctx.market.toLowerCase() ? computeMarketAbi : a === ctx.feed?.toLowerCase() ? markFeedAbi : a === ctx.settlementReceiver?.toLowerCase() ? [...settlementReceiverAbi, ...simulationReceiverAbi] : null;
    if (!abi) return [];
    return parseEventLogs({ abi, logs: [log], strict: false }).map((e) => (e as { eventName: string }).eventName);
  });

  const payload = payloadOf(tx.input);
  const settlement = target === "settlement" ? decodeSettlement(payload) : null;
  const mark = target === "mark" ? decodeMark(payload) : null;
  const forwarderResult = hit?.args.result ?? null;

  let outcome: DeliveryOutcome;
  if (receipt.status !== "success") outcome = "reverted";
  else if (forwarderResult === false) outcome = "refused";
  else if (target === "settlement" && events.some((e) => e === "Settled")) outcome = "settled";
  else if (target === "mark" && events.includes("MarkUpdated")) outcome = "mark-accepted";
  else outcome = "unconfirmed";

  const trace = outcome === "refused" || outcome === "reverted" ? await traceRevert(pc, txHash, receiverAddress) : null;

  return {
    txHash, blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex, timestamp: block.timestamp,
    sender: tx.from, target, receiver: receiverAddress, outcome, forwarderResult, events, settlement, mark,
    diagnosis: null, trace, note,
  };
}

const order = (a: Delivery, b: Delivery) =>
  a.blockNumber === b.blockNumber ? a.transactionIndex - b.transactionIndex : a.blockNumber < b.blockNumber ? -1 : 1;

// Diagnoses refused deliveries in chain order, so "already settled" and "mark does not advance" are judged
// against what had actually happened before each attempt.
export function annotate(deliveries: Delivery[], ctx: LedgerContext, env: LedgerEnv): Delivery[] {
  const t = env.snapshot.terms;
  let newestObserved: bigint | null = null;
  return [...deliveries].sort(order).map((d) => {
    const before =
      env.settlementAt !== null &&
      (env.settlementAt.blockNumber < d.blockNumber ||
        (env.settlementAt.blockNumber === d.blockNumber && env.settlementAt.transactionIndex < d.transactionIndex));
    let diagnosis: Diagnosis | null = null;
    if (d.outcome === "refused" || d.outcome === "reverted") {
      diagnosis =
        d.target === "settlement"
          ? diagnoseSettlement(d.settlement, {
              market: ctx.market, chainId: ctx.chainId, indexId: t.indexId, specHash: t.specHash, priceDecimals: t.priceDecimals,
              periodStart: t.periodStart, periodEnd: t.periodEnd, maxReportAge: t.maxReportAge, blockTimestamp: d.timestamp,
              alreadySettled: before, sender: d.sender, operator: env.operators.settlement,
            })
          : diagnoseMark(d.mark, {
              feed: d.receiver, chainId: ctx.chainId, indexId: t.indexId, blockTimestamp: d.timestamp, marketSettled: before,
              newestObservedAt: newestObserved, sender: d.sender, operator: env.operators.mark,
            });
    }
    if (d.outcome === "mark-accepted" && d.mark && (newestObserved === null || d.mark.observedAt > newestObserved)) newestObserved = d.mark.observedAt;
    return { ...d, diagnosis };
  });
}

function safeReceiver(input: Hex): Address | null {
  try {
    return decodeFunctionData({ abi: forwarderAbi, data: input }).args[0];
  } catch {
    return null;
  }
}

export interface ScanResult {
  hashes: Hex[];
  fromBlock: bigint;
  toBlock: bigint;
  truncated: boolean;
  requests: number;
  chunk: number;
  via: string;
  failedSources: string[];
}

// Newest chunks first, capped, so the public RPC's small getLogs window cannot turn one page view into
// thousands of requests. When the cap cuts the range, the result says so.
export async function scanReportProcessed(
  pc: PublicClient,
  opts: { forwarder: Address; receivers: Address[]; fromBlock: bigint; toBlock: bigint; chunk: number; maxRequests: number },
): Promise<ScanResult> {
  const step = BigInt(opts.chunk);
  const chunks: [bigint, bigint][] = [];
  for (let to = opts.toBlock; to >= opts.fromBlock && chunks.length < opts.maxRequests; to -= step) {
    const from = to - step + 1n > opts.fromBlock ? to - step + 1n : opts.fromBlock;
    chunks.push([from, to]);
  }
  const reached = chunks.at(-1)?.[0] ?? opts.toBlock;
  const hashes = new Set<Hex>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [from, to] = chunks[next++]!;
      const logs = await pc.getLogs({
        address: opts.forwarder, event: reportProcessedEvent, args: { receiver: opts.receivers }, fromBlock: from, toBlock: to,
      });
      for (const log of logs) if (log.transactionHash) hashes.add(log.transactionHash);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, chunks.length) }, worker));
  return { hashes: [...hashes], fromBlock: reached, toBlock: opts.toBlock, truncated: reached > opts.fromBlock, requests: chunks.length, chunk: opts.chunk, via: "", failedSources: [] };
}

export interface ManifestEntry {
  txHash: Hex;
  note: string | null;
}

// An attempt the workflow stopped before sending anything. It leaves no transaction, so it can only be
// reported by the run, never verified on-chain.
export interface OffchainRefusal {
  title: string;
  reason: string;
  note: string;
}

export interface Manifest {
  market: string | null;
  entries: ManifestEntry[];
  offchain: OffchainRefusal[];
}

// A pinned file that names a market is only valid for that market. Files that name none are accepted as is.
export const boundTo = (declared: string | null, market: string) => declared === null || declared.toLowerCase() === market.toLowerCase();

// A manifest only points at transactions. Every on-chain outcome shown is re-derived from the transaction's logs.
export async function loadManifest(base: string): Promise<Manifest | null> {
  const text = await fetchText(`${base}/deliveries.json`);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as {
      market?: string;
      entries?: { txHash?: string; note?: string }[];
      offchain?: { title?: string; reason?: string; note?: string }[];
    };
    const entries = (parsed.entries ?? []).flatMap((e) =>
      e.txHash && /^0x[0-9a-fA-F]{64}$/.test(e.txHash) ? [{ txHash: e.txHash as Hex, note: e.note ?? null }] : [],
    );
    const offchain = (parsed.offchain ?? []).flatMap((o) => (o.title && o.reason ? [{ title: o.title, reason: o.reason, note: o.note ?? "" }] : []));
    return { market: parsed.market ?? null, entries, offchain };
  } catch {
    return null;
  }
}
