import { formatUnits, parseUnits } from "viem";

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Truncates rather than rounds so a displayed balance is never above what the account holds.
export function fixed(raw: bigint, decimals: number, fractionDigits = 2): string {
  const negative = raw < 0n;
  const text = formatUnits(negative ? -raw : raw, decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  const frac = fraction.padEnd(fractionDigits, "0").slice(0, fractionDigits);
  return `${negative ? "-" : ""}${group(whole)}${fractionDigits > 0 ? `.${frac}` : ""}`;
}

export const usd = (raw: bigint, decimals: number, fractionDigits = 2) => `$${fixed(raw, decimals, fractionDigits)}`;

export function parseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return parseUnits(trimmed, decimals);
}

export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const shortHash = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`;
export const blockLabel = (n: bigint | number) => Number(n).toLocaleString("en-US");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function utc(timestamp: bigint | number, withSeconds = false): string {
  const d = new Date(Number(timestamp) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${time} UTC`;
}

export function duration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${s % 60}s`;
  return `${s}s`;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: string; message?: string; name?: string };
    return e.shortMessage ?? e.message ?? String(error);
  }
  return String(error);
}
