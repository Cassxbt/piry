// Enough getLogs calls in flight to keep a 20 requests/s limit busy at ~700 ms a call; rateLimitedFetch does the pacing.
export const SCAN_CONCURRENCY = 16;

// The public Monad RPC allows 15 requests per second per IP and counts every call inside a JSON-RPC batch.
// Reserving time slots keeps a burst of reads (receipts, log pages) from tripping it.
export function rateLimitedFetch(callsPerSecond: number, base: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  let nextFree = 0;
  const callCount = (init?: RequestInit) => {
    try {
      const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      return Array.isArray(parsed) ? Math.max(1, parsed.length) : 1;
    } catch {
      return 1;
    }
  };
  return async (input, init) => {
    const now = Date.now();
    const start = Math.max(now, nextFree);
    nextFree = start + (callCount(init) / callsPerSecond) * 1000;
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
    return base(input, init);
  };
}
