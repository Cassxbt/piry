import { isAddress, type Address } from "viem";

// Public information only. Private keys are never part of the bundle; they go in the submission form's access instructions.
export interface JudgeWallet {
  label: string;
  address: Address;
}

// The config file is hand-filled before submission; drop anything malformed rather than render a broken row.
export function parseJudgeWallets(input: unknown): JudgeWallet[] {
  if (!Array.isArray(input)) return [];
  const wallets: JudgeWallet[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const { label, address } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof address !== "string" || !isAddress(address)) continue;
    wallets.push({ label, address });
  }
  return wallets;
}
