export function deliveryOutcome(
  mode: "simulation" | "authenticated", transactionSucceeded: boolean,
  receiverStatus: "success" | "reverted" | "unknown",
): string {
  if (!transactionSucceeded || receiverStatus === "reverted") throw new Error("report delivery rejected");
  if (mode === "authenticated") {
    if (receiverStatus !== "success") throw new Error("receiver delivery status unverified");
    return "receiver reported success; independently verify authenticated onchain acceptance";
  }
  return receiverStatus === "success"
    ? "simulation forwarder call succeeded; receiver execution unconfirmed and not authenticated onchain proof: verify contract events"
    : "simulation report produced; receiver delivery unverified";
}
