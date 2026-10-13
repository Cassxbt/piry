import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { proveTransaction } from "../lib/lifecycle";
import { reportProcessedEvent, type LedgerContext } from "../lib/ledger";

const forwarder = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const receiver = "0x4444444444444444444444444444444444444444" as Address;
const feed = "0x5555555555555555555555555555555555555555" as Address;
const executionId = `0x${"11".repeat(32)}` as Hex;
const ctx: LedgerContext = { forwarder, market: "0x3333333333333333333333333333333333333333", settlementReceiver: receiver, feed, chainId: 10143n };

const processed = (to: Address, result: boolean) => ({
  address: forwarder,
  topics: encodeEventTopics({ abi: [reportProcessedEvent], eventName: "ReportProcessed", args: { receiver: to, workflowExecutionId: executionId, reportId: "0x0102" } }),
  data: encodeAbiParameters([{ type: "bool" }], [result]),
});
const client = (...logs: ReturnType<typeof processed>[]) =>
  ({ getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, logs }), getBlock: async () => ({ timestamp: 100n }) }) as never;

describe("proveTransaction receiver binding", () => {
  it("does not attribute another receiver's refusal to this series", async () => {
    const proof = await proveTransaction(client(processed(other, false)), ctx, executionId);
    expect(proof.forwarderResult).toBeNull();
    expect(proof.events).toEqual([]);
  });

  it("reads the result delivered to the series' own receiver or feed", async () => {
    expect((await proveTransaction(client(processed(receiver, false)), ctx, executionId)).forwarderResult).toBe(false);
    expect((await proveTransaction(client(processed(feed, true)), ctx, executionId)).forwarderResult).toBe(true);
  });

  it("ignores foreign deliveries in the same receipt and treats any refused own delivery as a refusal", async () => {
    expect((await proveTransaction(client(processed(other, false), processed(receiver, true)), ctx, executionId)).forwarderResult).toBe(true);
    expect((await proveTransaction(client(processed(receiver, true), processed(feed, false)), ctx, executionId)).forwarderResult).toBe(false);
  });
});
