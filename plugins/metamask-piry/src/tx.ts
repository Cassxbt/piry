import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { marketAbi } from "./chain.js";
import { PiryError } from "./errors.js";

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface Intent {
  summary: string;
  action: "custom";
}

export interface TxReceipt {
  hash: Hex;
  status: string;
}

// The only way this plugin changes chain state: hand a request to the Agent Wallet and wait for its verdict.
export interface Wallet {
  address: Address;
  send(tx: TxRequest, intent: Intent): Promise<TxReceipt>;
}

export const approveTx = (token: Address, spender: Address, amount: bigint): TxRequest => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});

export const transferTx = (token: Address, to: Address, amount: bigint): TxRequest => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
});

export const mintPairsTx = (market: Address, quantity: bigint): TxRequest => ({
  to: market,
  data: encodeFunctionData({ abi: marketAbi, functionName: "mintPairs", args: [quantity] }),
});

export const mergePairsTx = (market: Address, quantity: bigint, recipient: Address): TxRequest => ({
  to: market,
  data: encodeFunctionData({ abi: marketAbi, functionName: "mergePairs", args: [quantity, recipient] }),
});

export const redeemTx = (market: Address, longAmount: bigint, shortAmount: bigint, recipient: Address, minPayout: bigint): TxRequest => ({
  to: market,
  data: encodeFunctionData({ abi: marketAbi, functionName: "redeem", args: [longAmount, shortAmount, recipient, minPayout] }),
});

export interface StepLog {
  step: string;
  summary: string;
  hash: Hex;
  status: string;
  confirmedBy: "host" | "chain";
}

// Agent Wallet job statuses (agent-wallet 7.1.0): only CONFIRMED means the transaction was mined. These end a job
// without a mined success. Every other status (BROADCASTED, the tracking-expired ones, anything new or missing) says
// nothing final, so the chain receipt decides.
const MINED = "CONFIRMED";
const REJECTED = new Set(["FAILED", "BROADCAST_FAILED", "DENIED", "EXPIRED", "REVERTED"]);
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 2_000;

export interface ReceiptSource {
  waitForTransactionReceipt(args: { hash: Hex; timeout: number; pollingInterval: number }): Promise<{ status: "success" | "reverted" }>;
}

// FAILED: known not to have succeeded. UNCERTAIN: submitted, but neither the host nor the chain confirmed it, so it
// may still land.
export type Outcome = "FAILED" | "UNCERTAIN";

export class Budget {
  spent = 0n;

  constructor(readonly cap: bigint | null) {}

  check(amount: bigint, step = "purchase"): void {
    if (amount < 0n) throw new RangeError("negative spend");
    if (this.cap !== null && this.spent + amount > this.cap) {
      throw new PiryError(
        "CAP_EXCEEDED",
        `The ${step} would bring spending to ${this.spent + amount} base units, above the cap of ${this.cap}. Nothing was sent for it.`,
        "Raise --max-premium only if the user agreed to a larger budget.",
      );
    }
  }

  charge(amount: bigint, step: string): void {
    this.check(amount, step);
    this.spent += amount;
  }
}

export class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly completed: readonly StepLog[],
    readonly cause: unknown,
    readonly outcome: Outcome = "FAILED",
    readonly hash: Hex | null = null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StepFailed";
  }
}

// Executes steps in order. Spend is charged before a step is sent, so a cap breach never reaches the wallet. A step is
// completed only on a mined success; anything else stops the run, so no dependent write is ever built on it.
export class Run {
  readonly steps: StepLog[] = [];

  constructor(
    private readonly wallet: Wallet,
    readonly budget: Budget,
    private readonly note: (line: string) => void = () => {},
    private readonly chain?: ReceiptSource,
  ) {}

  async send(step: string, summary: string, tx: TxRequest, spend = 0n): Promise<StepLog> {
    this.budget.charge(spend, step);
    let receipt: TxReceipt;
    try {
      receipt = await this.wallet.send(tx, { summary, action: "custom" });
    } catch (cause) {
      throw new StepFailed(step, [...this.steps], cause);
    }
    const status = String(receipt.status ?? "").toUpperCase();
    const shown = status || "(none)";
    if (!receipt.hash || receipt.hash === "0x") {
      throw new StepFailed(step, [...this.steps], new Error(`The wallet returned status ${shown} without a transaction hash, so the outcome cannot be verified.`), "UNCERTAIN");
    }
    const hash = receipt.hash;
    const stop = (outcome: Outcome, reason: string) => new StepFailed(step, [...this.steps], new Error(reason), outcome, hash);
    let confirmedBy: StepLog["confirmedBy"] = "host";
    if (REJECTED.has(status)) throw stop("FAILED", `The wallet reported status ${status} for transaction ${hash}.`);
    if (status !== MINED) {
      const mined = await this.receiptStatus(hash);
      if (mined === "reverted") throw stop("FAILED", `Transaction ${hash} reverted on chain (wallet status ${shown}).`);
      if (mined === null) throw stop("UNCERTAIN", `The wallet returned status ${shown} for ${hash} and no receipt was found within ${RECEIPT_TIMEOUT_MS / 1000} s; it may still be mined.`);
      confirmedBy = "chain";
    }
    const log: StepLog = { step, summary, hash, status: receipt.status ?? "", confirmedBy };
    this.steps.push(log);
    this.note(`${step}: ${receipt.status}${confirmedBy === "chain" ? " (mined, per chain receipt)" : ""} ${hash}`);
    return log;
  }

  private async receiptStatus(hash: Hex): Promise<"success" | "reverted" | null> {
    if (!this.chain) return null;
    try {
      return (await this.chain.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: RECEIPT_POLL_MS })).status;
    } catch {
      return null;
    }
  }
}
