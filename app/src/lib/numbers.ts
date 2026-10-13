// Fixed decimals with trailing zeros trimmed down to a minimum, for prices that are exact at their own precision.
export function trimmed(value: number, min = 2, max = 6): string {
  const fixed = value.toFixed(max);
  const [whole = "0", fraction = ""] = fixed.split(".");
  const cut = fraction.replace(/0+$/, "").padEnd(min, "0");
  return cut.length > 0 ? `${whole}.${cut}` : whole;
}

export const raw = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;
