export interface DepthLevel {
  price: number;
  size: number;
}

export interface DepthPoint {
  price: number;
  bid: number | null;
  ask: number | null;
  bidCost: number | null;
  askCost: number | null;
}

export interface Depth {
  points: DepthPoint[];
  xMin: number;
  xMax: number;
  maxSize: number;
}

// Cumulative depth for a limit order book. `bids` are best (highest) first, `asks` best (lowest) first, as the book
// returns them. A bid point holds the size a seller would fill by selling down to that price; an ask point, the size
// a buyer would fill by paying up to it. `cost` is that cumulative size valued at each level's own price.
export function buildDepth(bids: readonly DepthLevel[], asks: readonly DepthLevel[]): Depth | null {
  if (bids.length === 0 && asks.length === 0) return null;
  const all = [...bids, ...asks].map((l) => l.price);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.08, 1e-6);
  const xMin = lo - pad;
  const xMax = hi + pad;

  let size = 0;
  let cost = 0;
  const bidPoints: DepthPoint[] = bids.map((l) => {
    size += l.size;
    cost += l.size * l.price;
    return { price: l.price, bid: size, ask: null, bidCost: cost, askCost: null };
  });
  const bidTotal = size;
  const bidCostTotal = cost;

  size = 0;
  cost = 0;
  const askPoints: DepthPoint[] = asks.map((l) => {
    size += l.size;
    cost += l.size * l.price;
    return { price: l.price, bid: null, ask: size, bidCost: null, askCost: cost };
  });

  const points: DepthPoint[] = [
    ...(bids.length ? [{ price: xMin, bid: bidTotal, ask: null, bidCost: bidCostTotal, askCost: null }] : []),
    ...bidPoints.reverse(),
    ...askPoints,
    ...(asks.length ? [{ price: xMax, bid: null, ask: size, bidCost: null, askCost: cost }] : []),
  ];
  return { points, xMin, xMax, maxSize: Math.max(bidTotal, size) };
}
