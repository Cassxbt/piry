export type FaucetStatus = "no-wallet" | "claimed" | "empty" | "ready";

export function faucetStatus(input: { connected: boolean; claimed: boolean | undefined; faucetBalance: bigint | undefined; amount: bigint | undefined }): FaucetStatus {
  if (!input.connected) return "no-wallet";
  if (input.claimed) return "claimed";
  if (input.faucetBalance !== undefined && input.amount !== undefined && input.faucetBalance < input.amount) return "empty";
  return "ready";
}
