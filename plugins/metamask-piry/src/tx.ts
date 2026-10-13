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
}

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
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StepFailed";
  }
}

// Executes steps in order. Spend is charged before a step is sent, so a cap breach never reaches the wallet.
export class Run {
  readonly steps: StepLog[] = [];

  constructor(
    private readonly wallet: Wallet,
    readonly budget: Budget,
    private readonly note: (line: string) => void = () => {},
  ) {}

  async send(step: string, summary: string, tx: TxRequest, spend = 0n): Promise<StepLog> {
    this.budget.charge(spend, step);
    let receipt: TxReceipt;
    try {
      receipt = await this.wallet.send(tx, { summary, action: "custom" });
    } catch (cause) {
      throw new StepFailed(step, [...this.steps], cause);
    }
    if (!receipt.hash || receipt.hash === "0x") {
      throw new StepFailed(step, [...this.steps], new Error(`The wallet returned status ${receipt.status} without a transaction hash.`));
    }
    const log: StepLog = { step, summary, hash: receipt.hash, status: receipt.status };
    this.steps.push(log);
    this.note(`${step}: ${receipt.status} ${receipt.hash}`);
    return log;
  }
}
