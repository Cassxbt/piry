// Seeds liquidity on Piry's two Kuru V2 spot markets (PIRY-L/USDC, PIRY-S/USDC).
//
//   bun scripts/seed-kuru.ts [--network local|monad-testnet] [--budget 20000] [--pairs 8000] [--levels 5]
//        [--spread 2] [--step 1] [--size <claims per level>] [--no-dry-run] [--confirm]
//
// Dry-run is the default: it reads chain state and prints the plan, and sends nothing.
// local: forks Monad testnet in a loopback Anvil (or attaches to LOCAL_RPC_URL on loopback) and impersonates
//   the deployer, so no key is needed. Only monad-testnet with --no-dry-run --confirm sends real transactions.
// monad-testnet: key from DEPLOYER_PRIVATE_KEY in the environment only; RPC from MONAD_TESTNET_RPC (optional).
// Re-runs are idempotent: own resting orders are cancelled first, pairs are minted only to cover the shortfall.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaseError, createPublicClient, createWalletClient, custom, defineChain, erc20Abi, formatUnits, getAddress, http,
  numberToHex, parseAbi, type Address, type Chain, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  cancelSlots, confirmed, depositToKuru, describeOutcome, openSession, readKuruAccount, readKuruBook, readOpenOrders,
  marketIssues, type KuruBook, type Session,
} from '../app/src/lib/kuru.ts';
import { baseAtoms, checkLimitOrder, priceText, quoteNotional, sizeFromBaseAtoms, type MarketScale } from '../app/src/lib/kuruMath.ts';

const root = new URL('../', import.meta.url);
const CHAIN_ID = 10143;
const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
const BOOK_DEPTH = 20n;
const LONG_MARKET: Address = '0xe2393d5f15523931e59f340cffebcde30fa7db1a';
const SHORT_MARKET: Address = '0xd93db02c88d645e669a3965cd46e72cca137f193';

const feedAbi = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)']);
const marketAbi = parseAbi(['function mintPairs(uint256 quantity)']);
const coreAbi = parseAbi(['function spotTokenEnabled(address) view returns (bool)', 'function verifiedSpotOrderBook(address) view returns (bool)']);

class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message); };
const secrets: string[] = [];
const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('<redacted>'), text);
const describe = (error: unknown) =>
  redact(error instanceof BaseError ? [error.shortMessage, error.details].filter(Boolean).join(': ') : error instanceof Error ? error.message : String(error));

export interface Options {
  network: 'local' | 'monad-testnet';
  budget: bigint;
  pairs: bigint;
  levels: number;
  spreadBps: bigint;
  stepBps: bigint;
  size?: bigint;
  dryRun: boolean;
  confirm: boolean;
}

interface Config {
  deployer: Address;
  collateral: Address;
  market: Address;
  accountCore: Address;
  maxReportAge: number;
  venues: { name: string; kuru: Address; claim: Address; feed: Address }[];
}

const loadConfig = async (): Promise<Config> => {
  const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
  const [deployment, kuru] = await Promise.all([read('deployments/monad-testnet.json'), read('config/kuru-testnet.json')]);
  const c = deployment.contracts;
  return {
    deployer: getAddress(deployment.deployer),
    collateral: getAddress(c.collateral.address),
    market: getAddress(c.market.address),
    accountCore: getAddress(kuru.contracts.account_core),
    maxReportAge: Number(deployment.series.maxReportAge),
    venues: [
      { name: 'PIRY-L', kuru: getAddress(LONG_MARKET), claim: getAddress(c.longClaim.address), feed: getAddress(c.markFeed.address) },
      { name: 'PIRY-S', kuru: getAddress(SHORT_MARKET), claim: getAddress(c.shortClaim.address), feed: getAddress(c.shortFeed.address) },
    ],
  };
};

export interface Env {
  options: Options;
  config: Config;
  chain: Chain;
  pc: PublicClient;
  wallet?: WalletClient;
  owner: Address;
  stop: () => Promise<void>;
}

const startFork = async (upstream: string) => {
  const attach = process.env.LOCAL_RPC_URL;
  if (attach) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(attach).hostname)) fail('LOCAL_RPC_URL must point at loopback');
    return { url: attach, stop: async () => {} };
  }
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const node = spawn('anvil', ['--fork-url', upstream, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let startupError: Error | undefined;
  node.on('error', (error) => { startupError = error; });
  node.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (node.exitCode === null) {
      const exited = once(node, 'exit');
      node.kill('SIGTERM');
      await exited;
    }
  };
  const probe = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 2000 }) });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (startupError) throw startupError;
    if (node.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try { await probe.getChainId(); return { url, stop }; } catch { /* Startup only. */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  await stop();
  return fail('Anvil fork did not start');
};

// The public RPC allows 15 requests per second, so spacing requests beats retrying a burst. Local nodes are unthrottled.
const pacedTransport = (url: string, gapMs: number) => {
  const rpc = http(url, { retryCount: 0 })({ chain: undefined });
  let nextAt = 0;
  return custom(
    {
      async request(args) {
        const at = Math.max(Date.now(), nextAt);
        nextAt = at + gapMs;
        if (at > Date.now()) await new Promise((done) => setTimeout(done, at - Date.now()));
        return rpc.request(args);
      },
    },
    { retryCount: 6, retryDelay: 400 },
  );
};

export async function connect(options: Options): Promise<Env> {
  const config = await loadConfig();
  const local = options.network === 'local';
  const upstream = process.env.MONAD_TESTNET_RPC || DEFAULT_RPC;
  const node = local ? await startFork(upstream) : { url: upstream, stop: async () => {} };
  const chain = defineChain({ id: CHAIN_ID, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [node.url] } } });
  const transport = pacedTransport(node.url, local ? 0 : 100);
  const pc = createPublicClient({ chain, transport, pollingInterval: 1000 });
  try {
    const chainId = await pc.getChainId();
    if (chainId !== CHAIN_ID) fail(`RPC reports chain ${chainId}, expected ${CHAIN_ID}`);
    if (local) {
      // The public RPC rejects anvil_*; this keeps a mistyped LOCAL_RPC_URL from ever being treated as a sandbox.
      await pc.request({ method: 'anvil_nodeInfo' } as never).catch(() => fail('local mode needs an Anvil node'));
      await pc.request({ method: 'anvil_impersonateAccount', params: [config.deployer] } as never);
      await pc.request({ method: 'anvil_setBalance', params: [config.deployer, numberToHex(100n * 10n ** 18n)] } as never);
      const wallet = createWalletClient({ account: config.deployer, chain, transport });
      return { options, config, chain, pc, wallet, owner: config.deployer, stop: node.stop };
    }
    if (options.dryRun) return { options, config, chain, pc, owner: config.deployer, stop: node.stop };
    if (!options.confirm) fail('refusing to send transactions to monad-testnet without --confirm');
    const raw = process.env.DEPLOYER_PRIVATE_KEY ?? '';
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) fail('DEPLOYER_PRIVATE_KEY must be set in the environment as 32 bytes of hex');
    const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
    secrets.push(raw, key);
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain, transport });
    return { options, config, chain, pc, wallet, owner: account.address, stop: node.stop };
  } catch (error) {
    await node.stop();
    throw error;
  }
}

export interface PlannedOrder {
  isBuy: boolean;
  priceRaw: bigint;
  sizeRaw: bigint;
}

const BPS = 10_000n;
const PPS = 10_000_000n;

// Kuru reserves the maker fee on top of a bid's notional.
const reserveWithFee = (notional: bigint, makerPps: bigint) => (notional * (PPS + makerPps) + PPS - 1n) / PPS;

// Bids round down to the tick and asks round up, so a level never lands inside the spread by rounding.
export function planLevels(a: {
  scale: MarketScale;
  fairRaw: bigint;
  levels: number;
  spreadBps: bigint;
  stepBps: bigint;
  askAtoms: bigint;
  bidBudget: bigint;
  makerPps: bigint;
  sizeRaw?: bigint;
}): PlannedOrder[] {
  const { scale, levels } = a;
  const n = BigInt(levels);
  const quoteUnit = 10n ** BigInt(scale.quoteDecimals);
  const askTotal = sizeFromBaseAtoms(a.askAtoms, scale);
  const orders: PlannedOrder[] = [];
  for (let i = 0; i < levels; i++) {
    const offset = a.spreadBps + BigInt(i) * a.stepBps;
    if (offset >= BPS) fail(`level ${i + 1} would price a bid at or below zero`);
    const bid = ((a.fairRaw * (BPS - offset)) / BPS / scale.tickSize) * scale.tickSize;
    const ask = ((a.fairRaw * (BPS + offset) + BPS * scale.tickSize - 1n) / (BPS * scale.tickSize)) * scale.tickSize;
    const perLevel = (a.bidBudget * PPS) / (PPS + a.makerPps) / n;
    const bidSize = a.sizeRaw ?? (perLevel * scale.pricePrecision * scale.sizePrecision) / (bid * quoteUnit);
    const askSize = a.sizeRaw ?? askTotal / n + (i === levels - 1 ? askTotal % n : 0n);
    orders.push({ isBuy: true, priceRaw: bid, sizeRaw: bidSize }, { isBuy: false, priceRaw: ask, sizeRaw: askSize });
  }
  for (const o of orders) {
    const issue = checkLimitOrder(o.priceRaw, o.sizeRaw, scale);
    if (issue) fail(`${o.isBuy ? 'bid' : 'ask'} ${priceText(o.priceRaw, scale)} x ${o.sizeRaw}: ${issue}`);
  }
  return orders;
}

const usdc = (atoms: bigint) => formatUnits(atoms, 6);
const notionalOf = (o: PlannedOrder, scale: MarketScale) => quoteNotional(o.priceRaw, o.sizeRaw, scale);

interface Venue {
  name: string;
  kuru: Address;
  claim: Address;
  book: KuruBook;
  fairRaw: bigint;
  orders: PlannedOrder[];
  own: { slot: number }[];
}

export interface BookRow {
  side: 'bid' | 'ask';
  price: string;
  size: string;
  notionalUsdc: string;
  expected: string;
  onBook: string;
}

export interface SeedReport {
  dryRun: boolean;
  txs: { label: string; hash: Hex }[];
  venues: { name: string; market: Address; fair: string; rows: BookRow[]; ownOrders: number; missing: number }[];
}

const levelAt = (levels: KuruBook['bids'], priceRaw: bigint) => levels.find((l) => l.priceRaw === priceRaw)?.sizeRaw ?? 0n;

const bookRows = (v: Venue, book: KuruBook): BookRow[] => {
  const scale = book.scale;
  const expected = new Map(v.orders.map((o) => [`${o.isBuy}:${o.priceRaw}`, o.sizeRaw]));
  const row = (side: 'bid' | 'ask', priceRaw: bigint, sizeRaw: bigint): BookRow => {
    const want = expected.get(`${side === 'bid'}:${priceRaw}`);
    return {
      side,
      price: priceText(priceRaw, scale),
      size: sizeRaw.toString(),
      notionalUsdc: usdc(notionalOf({ isBuy: side === 'bid', priceRaw, sizeRaw }, scale)),
      expected: want === undefined ? '' : want.toString(),
      onBook: want === undefined ? 'other' : sizeRaw >= want ? 'ok' : 'SHORT',
    };
  };
  const asks = [...book.asks].sort((a, b) => Number(b.priceRaw - a.priceRaw)).map((l) => row('ask', l.priceRaw, l.sizeRaw));
  const bids = [...book.bids].sort((a, b) => Number(b.priceRaw - a.priceRaw)).map((l) => row('bid', l.priceRaw, l.sizeRaw));
  const missing = v.orders
    .filter((o) => levelAt(o.isBuy ? book.bids : book.asks, o.priceRaw) === 0n)
    .map((o) => ({ ...row(o.isBuy ? 'bid' : 'ask', o.priceRaw, 0n), onBook: 'MISSING' }));
  return [...asks, ...bids, ...missing];
};

const readFair = async (env: Env, feed: Address, scale: MarketScale) => {
  const [round, decimals, block] = await Promise.all([
    env.pc.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }),
    env.pc.readContract({ address: feed, abi: feedAbi, functionName: 'decimals' }),
    env.pc.getBlock(),
  ]);
  const [, answer, , updatedAt] = round;
  if (answer <= 0n) fail(`feed ${feed} reports a non-positive answer`);
  const age = Number(block.timestamp - updatedAt);
  if (age > env.config.maxReportAge) fail(`feed ${feed} is ${age}s old (limit ${env.config.maxReportAge}s)`);
  const unit = 10n ** BigInt(decimals);
  return { answer, unit, fairRaw: (answer * scale.pricePrecision + unit / 2n) / unit, age };
};

const balanceOf = (pc: PublicClient, token: Address, owner: Address) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

export async function seed(env: Env): Promise<SeedReport> {
  const { options: o, config, pc, owner } = env;
  const log: SeedReport['txs'] = [];
  const say = (text = '') => console.log(text);

  say(`network ${o.network}  owner ${owner}  mode ${o.dryRun ? 'DRY-RUN (nothing is sent)' : 'LIVE'}`);

  const books = await Promise.all(config.venues.map((v) => readKuruBook(pc, v.kuru, Number(BOOK_DEPTH))));
  const enabled = await Promise.all(config.venues.flatMap((v, i) => [
    pc.readContract({ address: config.accountCore, abi: coreAbi, functionName: 'verifiedSpotOrderBook', args: [v.kuru] }),
    pc.readContract({ address: config.accountCore, abi: coreAbi, functionName: 'spotTokenEnabled', args: [v.claim] }),
    pc.readContract({ address: config.accountCore, abi: coreAbi, functionName: 'spotTokenEnabled', args: [books[i]!.quoteToken] }),
  ]));
  config.venues.forEach((v, i) => {
    const issues = marketIssues(books[i]!, { base: v.claim, quote: config.collateral });
    if (issues.length) fail(`${v.name} market: ${issues.join(' ')}`);
    if (!enabled[i * 3] || !enabled[i * 3 + 1] || !enabled[i * 3 + 2]) fail(`${v.name}: AccountCore does not accept this market or its tokens (market ${enabled[i * 3]}, claim ${enabled[i * 3 + 1]}, usdc ${enabled[i * 3 + 2]})`);
  });

  if (o.budget < o.pairs * 10n ** 6n) fail('budget must cover the pairs to mint');
  const bidBudgetEach = (o.budget - o.pairs * 10n ** 6n) / BigInt(config.venues.length);
  const account = await readKuruAccount(pc, config.accountCore, owner, [config.collateral, ...config.venues.map((v) => v.claim)]);

  const venues: Venue[] = [];
  for (const [i, v] of config.venues.entries()) {
    const book = books[i]!;
    const fair = await readFair(env, v.feed, book.scale);
    const askAtoms = o.pairs * 10n ** BigInt(book.scale.baseDecimals);
    const orders = planLevels({
      scale: book.scale, fairRaw: fair.fairRaw, levels: o.levels, spreadBps: o.spreadBps, stepBps: o.stepBps, askAtoms, bidBudget: bidBudgetEach, makerPps: book.fees.makerPps,
      sizeRaw: o.size === undefined ? undefined : o.size * book.scale.sizePrecision,
    });
    const own = await readOpenOrders(pc, v.kuru, account.rootId, config.accountCore);
    const s = book.scale;
    say();
    say(`${v.name}/USDC  ${v.kuru}`);
    say(`  fair ${priceText(fair.fairRaw, s)} (feed ${formatUnits(fair.answer, Math.log10(Number(fair.unit)))}, ${fair.age}s old)  tick ${priceText(s.tickSize, s)}  size precision ${s.sizePrecision}  min/max notional ${usdc(s.minQuote)}/${usdc(s.maxQuote)} USDC  fees taker/maker ${book.fees.takerPps}/${book.fees.makerPps} pps`);
    say(`  own resting orders to cancel: ${own.length}`);
    console.table(orders.map((p) => ({ side: p.isBuy ? 'bid' : 'ask', price: priceText(p.priceRaw, s), size: p.sizeRaw.toString(), notionalUsdc: usdc(notionalOf(p, s)) })));
    venues.push({ name: v.name, kuru: v.kuru, claim: v.claim, book, fairRaw: fair.fairRaw, orders, own });
  }

  const holdings = async (token: Address) => {
    const bal = account.balances.find((b) => b.token.toLowerCase() === token.toLowerCase());
    return (await balanceOf(pc, token, owner)) + (bal ? bal.free + bal.reserved : 0n);
  };
  const kuruHeld = (token: Address) => {
    const bal = account.balances.find((b) => b.token.toLowerCase() === token.toLowerCase());
    return bal ? bal.free + bal.reserved : 0n;
  };
  const askNeed = (v: Venue) => v.orders.filter((x) => !x.isBuy).reduce((sum, x) => sum + baseAtoms(x.sizeRaw, v.book.scale), 0n);
  const bidNeed = (v: Venue) => v.orders.filter((x) => x.isBuy).reduce((sum, x) => sum + reserveWithFee(notionalOf(x, v.book.scale), v.book.fees.makerPps), 0n);

  // Cancelling returns reserved funds, so held = wallet + Kuru free + Kuru reserved.
  const claimShortfall = await Promise.all(venues.map(async (v) => {
    const held = await holdings(v.claim);
    const need = askNeed(v);
    return need > held ? need - held : 0n;
  }));
  const mintAtoms = claimShortfall.reduce((max, x) => (x > max ? x : max), 0n);
  const usdcNeedInKuru = venues.reduce((sum, v) => sum + bidNeed(v), 0n);
  const usdcTotal = await holdings(config.collateral);
  if (usdcTotal < mintAtoms + usdcNeedInKuru) fail(`needs ${usdc(mintAtoms + usdcNeedInKuru)} USDC, wallet and Kuru hold ${usdc(usdcTotal)}`);

  const walletUsdcAfterMint = (await balanceOf(pc, config.collateral, owner)) - mintAtoms;
  const depositUsdc = usdcNeedInKuru > kuruHeld(config.collateral) ? usdcNeedInKuru - kuruHeld(config.collateral) : 0n;
  if (depositUsdc > walletUsdcAfterMint) fail('wallet USDC after minting cannot cover the Kuru deposit');

  say();
  say(`plan: cancel ${venues.reduce((n, v) => n + v.own.length, 0)} orders, mint ${formatUnits(mintAtoms, 6)} pairs (${usdc(mintAtoms)} USDC), deposit ${usdc(depositUsdc)} USDC, bids reserve ${usdc(usdcNeedInKuru)} USDC (incl. maker fee), asks ${venues.map((v) => `${formatUnits(askNeed(v), 6)} ${v.name}`).join(' + ')}`);

  const report: SeedReport = { dryRun: o.dryRun, txs: log, venues: [] };
  if (o.dryRun) return report;
  const wallet = env.wallet ?? fail('no wallet in live mode');
  const send = async (label: string, hash: Hex) => {
    await confirmed(pc, hash);
    log.push({ label, hash });
    say(`  tx ${label} ${hash}`);
  };
  const write = (label: string, address: Address, abi: typeof marketAbi | typeof erc20Abi, functionName: string, args: readonly unknown[]) =>
    wallet.writeContract({ address, abi, functionName, args, chain: env.chain, account: wallet.account! } as never).then((hash) => send(label, hash));

  say();
  let session: Session = await openSession(pc, wallet, config.accountCore);
  for (const v of venues) {
    if (v.own.length === 0) continue;
    await send(`cancel ${v.name}`, await cancelSlots(session, v.kuru, account.rootId, v.own.map((x) => x.slot)));
  }

  if (mintAtoms > 0n) {
    const allowance = await pc.readContract({ address: config.collateral, abi: erc20Abi, functionName: 'allowance', args: [owner, config.market] });
    if (allowance < mintAtoms) await write('approve USDC to market', config.collateral, erc20Abi, 'approve', [config.market, mintAtoms]);
    await write(`mintPairs ${formatUnits(mintAtoms, 6)}`, config.market, marketAbi, 'mintPairs', [mintAtoms]);
  }

  const toDeposit: [string, Address, bigint][] = [
    ...venues.map((v): [string, Address, bigint] => [v.name, v.claim, askNeed(v) > kuruHeld(v.claim) ? askNeed(v) - kuruHeld(v.claim) : 0n]),
    ['USDC', config.collateral, depositUsdc],
  ];
  for (const [label, token, amount] of toDeposit) {
    if (amount > 0n) await send(`deposit ${label} ${formatUnits(amount, 6)}`, await depositToKuru(session, token, amount));
  }

  session = await openSession(pc, wallet, config.accountCore);
  const rootId = await session.account.getRootAccountId({ rootOwner: owner });
  for (const v of venues) {
    const hash = await session.spot.batch({
      market: v.kuru,
      userId: rootId,
      orders: v.orders.map((p) => ({ side: p.isBuy ? 'buy' : 'sell', quantity: p.sizeRaw, price: p.priceRaw, tif: 'gtc', executionInstruction: 'postOnly', minSizeAfterBlock: 0n })),
      cancelSlotIdxs: [],
    });
    await send(`post ${v.orders.length} post-only orders ${v.name}`, hash);
    const outcome = await describeOutcome(await pc.getTransactionReceipt({ hash }), v.kuru);
    say(`  ${v.name} outcome ${outcome.label}, fills ${outcome.fills}`);
  }

  for (const v of venues) {
    const book = await readKuruBook(pc, v.kuru, Number(BOOK_DEPTH));
    const ownOrders = (await readOpenOrders(pc, v.kuru, rootId, config.accountCore)).length;
    const rows = bookRows(v, book);
    const missing = rows.filter((r) => r.onBook === 'MISSING' || r.onBook === 'SHORT').length;
    say();
    say(`${v.name}/USDC book at block ${book.block}  (own resting orders ${ownOrders}, expected ${v.orders.length})`);
    console.table(rows);
    report.venues.push({ name: v.name, market: v.kuru, fair: priceText(v.fairRaw, book.scale), rows, ownOrders, missing });
  }
  return report;
}

export async function cancelOwn(env: Env): Promise<number> {
  const { config, pc, owner } = env;
  const wallet = env.wallet ?? fail('no wallet');
  const session = await openSession(pc, wallet, config.accountCore);
  const rootId = await session.account.getRootAccountId({ rootOwner: owner });
  let cancelled = 0;
  for (const v of config.venues) {
    const own = await readOpenOrders(pc, v.kuru, rootId, config.accountCore);
    if (own.length === 0) continue;
    await confirmed(pc, await cancelSlots(session, v.kuru, rootId, own.map((x) => x.slot)));
    cancelled += own.length;
  }
  return cancelled;
}

const asInt = (name: string, text: string, min: number) => {
  if (!/^\d+$/.test(text) || Number(text) < min) fail(`--${name} must be an integer >= ${min}`);
  return BigInt(text);
};
const asBps = (name: string, text: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) fail(`--${name} must be a percentage with at most two decimals`);
  return BigInt(Math.round(Number(text) * 100));
};

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      network: { type: 'string', default: 'local' },
      budget: { type: 'string', default: '20000' },
      pairs: { type: 'string', default: '8000' },
      levels: { type: 'string', default: '5' },
      spread: { type: 'string', default: '2' },
      step: { type: 'string', default: '1' },
      size: { type: 'string' },
      'dry-run': { type: 'boolean', default: true },
      confirm: { type: 'boolean', default: false },
    },
    allowNegative: true,
    strict: true,
  });
  if (values.network !== 'local' && values.network !== 'monad-testnet') fail(`unknown network "${values.network}"; use local or monad-testnet`);
  const levels = Number(asInt('levels', values.levels!, 1));
  if (levels > 20) fail('--levels must be at most 20');
  return {
    network: values.network as Options['network'],
    budget: asInt('budget', values.budget!, 1) * 10n ** 6n,
    pairs: asInt('pairs', values.pairs!, 0),
    levels,
    spreadBps: asBps('spread', values.spread!),
    stepBps: asBps('step', values.step!),
    size: values.size === undefined ? undefined : asInt('size', values.size, 1),
    dryRun: values['dry-run']!,
    confirm: values.confirm!,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = async () => {
    const env = await connect(parseOptions(process.argv.slice(2)));
    try {
      const report = await seed(env);
      if (report.venues.some((v) => v.missing > 0 || v.ownOrders !== env.options.levels * 2)) {
        console.error('seeded book does not match the plan');
        process.exitCode = 1;
      }
    } finally {
      await env.stop();
    }
  };
  run().catch((error) => {
    console.error(error instanceof UsageError ? `error: ${error.message}` : `failed: ${describe(error)}`);
    process.exit(1);
  });
}
