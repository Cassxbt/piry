// Multi-wallet test trading on Piry's Kuru markets (PIRY-L/USDC, PIRY-S/USDC).
//
//   bun scripts/test-trades.ts [--network local|monad-testnet] [--wallets 8] [--seed 7] [--mon-each 0.25]
//        [--max-trades 50] [--max-usdc 1500] [--max-mon 3] [--sweep] [--sweep-only] [--no-dry-run] [--confirm]
//
// Dry-run is the default and prints the full plan. local forks Monad testnet in a loopback Anvil and impersonates the
// deployer (no key). Only monad-testnet with --no-dry-run --confirm sends real transactions, funded by DEPLOYER_PRIVATE_KEY.
// Test wallets are generated once and kept in .wallets.local.json (mode 0600, gitignored); keys are never printed.
// Output: evidence/test-trades.json (evidence/test-trades.local.json for a fork), ignored by the root allowlist.
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaseError, createWalletClient, custom, erc20Abi, formatUnits, maxUint256, parseAbi, parseEther, type Address, type Hex,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  confirmed, depositToKuru, describeOutcome, estimateSwap, openSession, readKuruAccount, readKuruBook, withdrawFromKuru,
  type KuruBook, type Session,
} from '../app/src/lib/kuru.ts';
import { baseAtoms, checkLimitOrder, priceHuman, quoteNotional, slippageFloor } from '../app/src/lib/kuruMath.ts';
import { connect, parseOptions, type Env } from './seed-kuru.ts';

const root = new URL('../', import.meta.url);
const WALLETS_FILE = fileURLToPath(new URL('.wallets.local.json', root));
const LABEL = 'Test activity by the Piry team from team-generated wallets on Monad testnet; much of it crosses the team\'s own seeded liquidity. Not organic usage.';
const MIN_TRADE = 2;
const MAX_TRADE = 60;
const SLIPPAGE_BPS = 50;
const USDC = 10n ** 6n;
const PERSONAS = ['hedger', 'gpu-host', 'short-buyer', 'round-tripper', 'minter-merger'] as const;

const marketAbi = parseAbi(['function mintPairs(uint256 quantity)', 'function mergePairs(uint256 quantity, address recipient)']);

class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message); };
const keys: string[] = [];
const describe = (error: unknown) => {
  const text = error instanceof BaseError ? [error.shortMessage, error.details].filter(Boolean).join(': ') : error instanceof Error ? error.message : String(error);
  return keys.reduce((out, key) => out.split(key).join('<redacted>'), text);
};

export type Persona = (typeof PERSONAS)[number];
export type Order = { op: 'swap' | 'limit'; market: 'L' | 'S'; side: 'buy' | 'sell'; usdc: number };
export type Step = Order | { op: 'mint' | 'merge'; claims: number };
export interface WalletPlan { persona: Persona; fundUsdc: number; steps: Step[] }
export interface Caps { trades: number; usdc: number; mon: number }

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// k whole-USDC notionals summing to at most `total`, each within the per-trade bounds, with varied sizes.
function split(total: number, k: number, r: () => number): number[] {
  const n = Math.min(k, Math.floor(total / MIN_TRADE));
  if (n < 1) return [];
  const weights = Array.from({ length: n }, () => 0.3 + r() * 2.4);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.min(MAX_TRADE, Math.max(MIN_TRADE, Math.round((total * w) / sum))));
  while (out.reduce((a, b) => a + b, 0) > total) {
    const i = out.indexOf(Math.max(...out));
    if (out[i]! <= MIN_TRADE) return out.slice(0, -1);
    out[i]!--;
  }
  return out;
}

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export function planWallet(persona: Persona, fundUsdc: number, price: { L: number; S: number }, r: () => number): WalletPlan {
  const buys = (market: 'L' | 'S', sizes: number[]): Step[] =>
    sizes.map((usdc, i) => ({ op: i === sizes.length - 1 && sizes.length > 2 ? 'limit' : 'swap', market, side: 'buy', usdc }));
  let steps: Step[] = [];
  if (persona === 'hedger') steps = buys('L', split(fundUsdc * 0.9, int(r, 4, 7), r));
  else if (persona === 'short-buyer') steps = buys('S', split(fundUsdc * 0.9, int(r, 4, 7), r));
  else if (persona === 'round-tripper') {
    const market = r() < 0.5 ? 'L' : 'S';
    const bought = split(fundUsdc * 0.9, int(r, 3, 4), r);
    const sold = split(bought.reduce((a, b) => a + b, 0) * 0.5, int(r, 2, 3), r);
    steps = [...buys(market, bought), ...sold.map((usdc, i): Step => ({ op: i === sold.length - 1 ? 'limit' : 'swap', market, side: 'sell', usdc }))];
  } else if (persona === 'gpu-host') {
    const claims = Math.floor(fundUsdc * 0.95);
    const sold = split(claims * price.L * 0.9, int(r, 3, 5), r);
    const limitAt = int(r, 0, sold.length - 1);
    steps = [{ op: 'mint', claims }, ...sold.map((usdc, i): Step => ({ op: i === limitAt ? 'limit' : 'swap', market: 'L', side: 'sell', usdc }))];
  } else {
    const claims = Math.floor(fundUsdc * 0.9);
    const merged = Math.max(1, Math.floor(claims * (0.3 + r() * 0.3)));
    const rest = Math.min(MAX_TRADE, Math.floor((claims - merged) * price.S * 0.95));
    steps = [{ op: 'mint', claims }, { op: 'merge', claims: merged }, ...(rest >= MIN_TRADE ? [{ op: 'swap', market: 'S', side: 'sell', usdc: rest } as Step] : [])];
  }
  return { persona, fundUsdc, steps };
}

export function buildPlans(n: number, seed: number, price: { L: number; S: number }): WalletPlan[] {
  const r = mulberry32(seed);
  const order = [...PERSONAS].sort(() => r() - 0.5);
  return Array.from({ length: n }, (_, i) => planWallet(order[i % order.length]!, 10 + Math.floor(140 * r()), price, r));
}

const isTrade = (s: Step): s is Order => s.op === 'swap' || s.op === 'limit';

export function capIssues(plans: WalletPlan[], monEach: number, caps: Caps): string[] {
  const issues: string[] = [];
  const trades = plans.flatMap((p) => p.steps.filter(isTrade));
  const usdc = plans.reduce((sum, p) => sum + p.fundUsdc, 0);
  if (trades.length > caps.trades) issues.push(`plan has ${trades.length} trades, cap is ${caps.trades}`);
  if (usdc > caps.usdc) issues.push(`plan sends ${usdc} USDC from the deployer, cap is ${caps.usdc}`);
  if (plans.length * monEach > caps.mon) issues.push(`plan sends ${plans.length * monEach} MON, cap is ${caps.mon}`);
  for (const t of trades) if (t.usdc < 1 || t.usdc > MAX_TRADE) issues.push(`trade notional ${t.usdc} USDC is outside 1-${MAX_TRADE}`);
  for (const p of plans) if (p.fundUsdc < 1 || p.fundUsdc > 150) issues.push(`wallet funding ${p.fundUsdc} USDC is outside 1-150`);
  return issues;
}

interface StoredWallet { address: Address; privateKey: Hex }

async function loadWallets(count: number): Promise<StoredWallet[]> {
  let stored: StoredWallet[] = [];
  try { stored = JSON.parse(await readFile(WALLETS_FILE, 'utf8')).wallets; } catch { /* First run. */ }
  const grown = stored.length < count;
  while (stored.length < count) {
    const privateKey = generatePrivateKey();
    stored.push({ address: privateKeyToAccount(privateKey).address, privateKey });
  }
  if (grown) {
    await writeFile(WALLETS_FILE, JSON.stringify({ version: 1, wallets: stored }, null, 2), { mode: 0o600 });
    await chmod(WALLETS_FILE, 0o600);
  }
  stored.forEach((w) => keys.push(w.privateKey, w.privateKey.slice(2)));
  return stored;
}

interface Op { wallet: string; kind: string; hash: Hex; gasUsed: bigint; gasLimit: bigint; gasPrice: bigint }
interface Trade {
  n: number; wallet: Address; persona: Persona; market: string; kind: 'market' | 'limit-ioc'; side: 'buy' | 'sell';
  plannedUsdc: number; status: 'filled' | 'partial' | 'unfilled' | 'failed' | 'skipped'; txHash?: Hex; sizeClaims?: string;
  limitPrice?: number; minOut?: string; outcome?: string; fills?: number; claimsFilled?: number; usdcMoved?: number;
  avgPrice?: number; gasUsed?: string; note?: string;
}

const claimsOf = (atoms: bigint) => Number(formatUnits(atoms, 6));
const usdcOf = (atoms: bigint) => Number(formatUnits(atoms, 6));
const jsonSafe = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

async function run(env: Env, args: { wallets: number; seed: number; monEach: number; caps: Caps; sweep: boolean; sweepOnly: boolean }) {
  const { config, pc } = env;
  const live = !env.options.dryRun;
  const [L, S] = config.venues;
  const venue = { L: L!, S: S! };
  const books = { L: await readKuruBook(pc, L!.kuru, 20), S: await readKuruBook(pc, S!.kuru, 20) };
  const mid = (b: KuruBook) => {
    const bid = Math.max(...b.bids.map((l) => Number(l.priceRaw)));
    const ask = Math.min(...b.asks.map((l) => Number(l.priceRaw)));
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) fail(`${b.market} needs a bid and an ask`);
    return (bid + ask) / 2 / Number(b.scale.pricePrecision);
  };
  const price = { L: mid(books.L), S: mid(books.S) };

  const stored = await loadWallets(args.sweepOnly ? Math.max(args.wallets, 1) : args.wallets);
  const plans = buildPlans(args.wallets, args.seed, price);
  const monWei = parseEther(String(args.monEach));
  const balanceOf = (token: Address, owner: Address) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const tokens = [config.collateral, L!.claim, S!.claim];

  const holdings = async (address: Address) => {
    const [mon, wallet, kuru] = await Promise.all([
      pc.getBalance({ address }),
      Promise.all(tokens.map((t) => balanceOf(t, address))),
      readKuruAccount(pc, config.accountCore, address, tokens),
    ]);
    return { mon, wallet, kuru: kuru.balances.map((b) => b.free + b.reserved), rootId: kuru.rootId };
  };

  const say = (text = '') => console.log(text);
  say(`network ${env.options.network}  mode ${live ? 'LIVE' : 'DRY-RUN (nothing is sent)'}  deployer ${env.owner}`);
  say(`mid PIRY-L ${price.L.toFixed(4)}  PIRY-S ${price.S.toFixed(4)}`);

  if (args.sweepOnly) {
    const rows = await Promise.all(stored.map(async (w) => ({ w, h: await holdings(w.address) })));
    console.table(rows.map(({ w, h }) => ({ wallet: w.address, mon: formatUnits(h.mon, 18), usdc: formatUnits(h.wallet[0]! + h.kuru[0]!, 6), long: formatUnits(h.wallet[1]! + h.kuru[1]!, 6), short: formatUnits(h.wallet[2]! + h.kuru[2]!, 6) })));
    if (!live) return;
    return sweep(env, stored, [], say, L!.claim, S!.claim);
  }

  const [depositor, depositorMon] = await Promise.all([balanceOf(config.collateral, env.owner), pc.getBalance({ address: env.owner })]);
  const funding = await Promise.all(stored.slice(0, args.wallets).map(async (w, i) => {
    const h = await holdings(w.address);
    const wantUsdc = BigInt(plans[i]!.fundUsdc) * USDC;
    return { usdc: wantUsdc > h.wallet[0]! + h.kuru[0]! ? wantUsdc - h.wallet[0]! - h.kuru[0]! : 0n, mon: monWei > h.mon ? monWei - h.mon : 0n };
  }));

  say();
  console.table(plans.map((p, i) => ({ wallet: i + 1, address: stored[i]!.address, persona: p.persona, fundUsdc: Number(funding[i]!.usdc / USDC), fundMon: formatUnits(funding[i]!.mon, 18), steps: p.steps.length, trades: p.steps.filter(isTrade).length })));
  console.table(plans.flatMap((p, i) => p.steps.map((s, j) => ({
    wallet: i + 1, step: j + 1, op: s.op, market: 'market' in s ? `PIRY-${s.market}` : '', side: 'side' in s ? s.side : '',
    kind: s.op === 'swap' ? 'market' : s.op === 'limit' ? 'limit-ioc' : '', approxUsdc: 'usdc' in s ? s.usdc : s.claims,
  }))));
  const sendUsdc = funding.reduce((a, f) => a + f.usdc, 0n);
  const sendMon = funding.reduce((a, f) => a + f.mon, 0n);
  const tradeCount = plans.reduce((n, p) => n + p.steps.filter(isTrade).length, 0);
  say(`totals: ${tradeCount} trades, ${args.wallets} wallets, deployer sends ${formatUnits(sendUsdc, 6)} USDC and ${formatUnits(sendMon, 18)} MON; deployer holds ${formatUnits(depositor, 6)} USDC, ${formatUnits(depositorMon, 18)} MON`);
  say(`caps: trades <= ${args.caps.trades}, USDC <= ${args.caps.usdc}, MON <= ${args.caps.mon}${args.sweep ? '; sweep after trading' : ''}`);
  const issues = capIssues(plans, args.monEach, args.caps);
  if (sendUsdc > depositor) issues.push('deployer USDC is below the plan');
  if (sendMon + parseEther('0.5') > depositorMon) issues.push('deployer MON is below the plan');
  if (issues.length) fail(`plan refused:\n  ${issues.join('\n  ')}`);
  if (!live) return;

  const evidenceFile = fileURLToPath(new URL(env.options.network === 'local' ? 'evidence/test-trades.local.json' : 'evidence/test-trades.json', root));
  if (env.options.network !== 'local' && await stat(evidenceFile).then(() => true, () => false)) fail(`${evidenceFile} exists; move it aside before another live run`);

  const log: Op[] = [];
  const trades: Trade[] = [];
  const walletRows: { address: Address; persona: Persona; fundedUsdc: number; fundedMon: string }[] = [];
  const started = new Date().toISOString();
  const view = async (address: Address) => {
    const h = await holdings(address);
    return { mon: formatUnits(h.mon, 18), walletUsdc: formatUnits(h.wallet[0]!, 6), walletLong: formatUnits(h.wallet[1]!, 6), walletShort: formatUnits(h.wallet[2]!, 6), kuruUsdc: formatUnits(h.kuru[0]!, 6), kuruLong: formatUnits(h.kuru[1]!, 6), kuruShort: formatUnits(h.kuru[2]!, 6) };
  };
  const deployerBefore = await view(env.owner);
  const track = async (wallet: string, kind: string, hash: Hex) => {
    const [receipt, tx] = await Promise.all([confirmed(pc, hash), pc.getTransaction({ hash })]);
    log.push({ wallet, kind, hash, gasUsed: receipt.gasUsed, gasLimit: tx.gas, gasPrice: receipt.effectiveGasPrice });
    return receipt;
  };
  const write = (wc: WalletClient, address: Address, abi: typeof erc20Abi | typeof marketAbi, functionName: string, args: readonly unknown[]) =>
    wc.writeContract({ address, abi, functionName, args, chain: env.chain, account: wc.account! } as never);

  const dep = env.wallet!;
  for (const [i, w] of stored.slice(0, args.wallets).entries()) {
    const f = funding[i]!;
    if (f.usdc > 0n) await track('deployer', 'fund-usdc', await write(dep, config.collateral, erc20Abi, 'transfer', [w.address, f.usdc]));
    if (f.mon > 0n) await track('deployer', 'fund-mon', await dep.sendTransaction({ to: w.address, value: f.mon, chain: env.chain, account: dep.account! } as never));
    walletRows.push({ address: w.address, persona: plans[i]!.persona, fundedUsdc: usdcOf(f.usdc), fundedMon: formatUnits(f.mon, 18) });
  }

  const save = async (final: boolean) => {
    const residual = final && args.sweep ? await Promise.all(stored.slice(0, args.wallets).map(async (w) => ({ address: w.address, ...(await view(w.address)) }))) : undefined;
    const sent = trades.filter((t) => t.status !== 'skipped');
    const filled = sent.filter((t) => (t.claimsFilled ?? 0) > 0);
    const byKind: Record<string, { count: number; avgGasUsed: number; avgGasLimit: number }> = {};
    for (const kind of new Set(log.map((o) => o.kind))) {
      const group = log.filter((o) => o.kind === kind);
      byKind[kind] = { count: group.length, avgGasUsed: Math.round(group.reduce((a, o) => a + Number(o.gasUsed), 0) / group.length), avgGasLimit: Math.round(group.reduce((a, o) => a + Number(o.gasLimit), 0) / group.length) };
    }
    const doc = {
      label: LABEL, network: env.options.network, complete: final, startedAt: started, finishedAt: new Date().toISOString(),
      params: { wallets: args.wallets, seed: args.seed, monEach: args.monEach, caps: args.caps },
      summary: {
        trades: sent.length, fills: filled.length, volumeUsdc: Number(filled.reduce((a, t) => a + (t.usdcMoved ?? 0), 0).toFixed(6)),
        uniqueWallets: new Set(sent.map((t) => t.wallet)).size, uniqueWalletsWithFills: new Set(filled.map((t) => t.wallet)).size,
        gasByOperation: byKind,
        monCostAtGasLimit: formatUnits(log.reduce((a, o) => a + o.gasLimit * o.gasPrice, 0n), 18),
        deployer: { before: deployerBefore, after: await view(env.owner) },
      },
      wallets: walletRows, residual, trades, transactions: log,
    };
    await writeFile(evidenceFile, JSON.stringify(doc, jsonSafe, 2));
  };

  let tradeNo = 0;
  for (const [i, plan] of plans.entries()) {
    const w = stored[i]!;
    const wc = createWalletClient({ account: privateKeyToAccount(w.privateKey), chain: env.chain, transport: custom({ request: pc.request as never }) });
    const session: Session = await openSession(pc, wc, config.accountCore);
    const me = w.address;
    let failures = 0;

    const allow = async (token: Address, spender: Address, need: bigint) => {
      const have = await pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, spender] });
      if (have < need) await track(me, 'approve', await write(wc, token, erc20Abi, 'approve', [spender, maxUint256]));
    };
    const ensureKuru = async (token: Address, need: bigint) => {
      const free = (await readKuruAccount(pc, config.accountCore, me, [token])).balances[0]!.free;
      if (free >= need) return true;
      const wallet = await balanceOf(token, me);
      if (free + wallet < need) return false;
      await allow(token, config.accountCore, wallet);
      await track(me, 'deposit', await depositToKuru(session, token, wallet));
      return true;
    };
    const held = async (token: Address) => (await balanceOf(token, me)) + (await readKuruAccount(pc, config.accountCore, me, [token])).balances[0]!.free;

    for (const step of plan.steps) {
      const trade: Trade | undefined = isTrade(step)
        ? { n: ++tradeNo, wallet: me, persona: plan.persona, market: `PIRY-${step.market}`, kind: step.op === 'swap' ? 'market' : 'limit-ioc', side: step.side, plannedUsdc: step.usdc, status: 'skipped' }
        : undefined;
      if (trade) trades.push(trade);
      try {
        if (step.op === 'mint') {
          const atoms = BigInt(step.claims) * USDC;
          await allow(config.collateral, config.market, atoms);
          await track(me, 'mintPairs', await write(wc, config.market, marketAbi, 'mintPairs', [atoms]));
        } else if (step.op === 'merge') {
          const atoms = BigInt(step.claims) * USDC;
          await track(me, 'mergePairs', await write(wc, config.market, marketAbi, 'mergePairs', [atoms, me]));
        } else {
          const o = step as Order;
          const v = venue[o.market];
          const book = await readKuruBook(pc, v.kuru, 20);
          const scale = book.scale;
          const buy = o.side === 'buy';
          const ref = buy ? Math.min(...book.asks.map((l) => Number(l.priceRaw))) : Math.max(...book.bids.map((l) => Number(l.priceRaw)));
          if (!Number.isFinite(ref)) { trade!.note = 'empty book side'; continue; }
          const refPrice = ref / Number(scale.pricePrecision);
          const claimsWanted = Math.floor(o.usdc / refPrice);
          const claims = buy ? claimsWanted : Math.min(claimsWanted, Math.floor(claimsOf(await held(v.claim))));
          if (claims < 1 || claims * refPrice < 1) { trade!.note = 'below the 1 USDC market minimum or nothing to sell'; continue; }
          const quoteIn = BigInt(o.usdc) * USDC;
          const sizeAtoms = baseAtoms(BigInt(claims) * scale.sizePrecision, scale);

          const snapshot = () => readKuruAccount(pc, config.accountCore, me, [config.collateral, v.claim]);
          let before = await snapshot();
          let hash: Hex;
          let rootId: bigint;
          if (o.op === 'swap') {
            const amountIn = buy ? quoteIn : sizeAtoms;
            if (!(await ensureKuru(buy ? config.collateral : v.claim, amountIn))) { trade!.note = 'insufficient balance'; continue; }
            rootId = await session.account.getRootAccountId({ rootOwner: me });
            const estimate = await estimateSwap(pc, v.kuru, buy, amountIn, rootId);
            if (estimate.amountOut === 0n) { trade!.note = 'estimateSwap returned no output'; continue; }
            const minOut = slippageFloor(estimate.amountOut, SLIPPAGE_BPS);
            trade!.minOut = minOut.toString();
            before = await snapshot();
            hash = await session.spot.swap({ market: v.kuru, userId: rootId, isBuy: buy, amountIn, minAmountOut: minOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 120) });
            trade!.sizeClaims = String(claims);
          } else {
            const tick = scale.tickSize;
            const priceRaw = buy ? ((BigInt(ref) * 10_050n / 10_000n + tick - 1n) / tick) * tick : ((BigInt(ref) * 9_950n / 10_000n) / tick) * tick;
            const sizeRaw = buy ? (quoteIn * scale.pricePrecision * scale.sizePrecision) / (priceRaw * USDC) : BigInt(claims) * scale.sizePrecision;
            const issue = checkLimitOrder(priceRaw, sizeRaw, scale);
            if (issue) { trade!.note = issue; continue; }
            const need = buy ? (quoteNotional(priceRaw, sizeRaw, scale) * 10_100n) / 10_000n : baseAtoms(sizeRaw, scale);
            if (!(await ensureKuru(buy ? config.collateral : v.claim, need))) { trade!.note = 'insufficient balance'; continue; }
            rootId = await session.account.getRootAccountId({ rootOwner: me });
            before = await snapshot();
            hash = await session.spot.batch({ market: v.kuru, userId: rootId, orders: [{ side: o.side, quantity: sizeRaw, price: priceRaw, tif: 'ioc', executionInstruction: 'none', minSizeAfterBlock: 0n }], cancelSlotIdxs: [] });
            trade!.sizeClaims = sizeRaw.toString();
            trade!.limitPrice = priceHuman(priceRaw, scale);
          }
          trade!.txHash = hash;
          const receipt = await track(me, o.op === 'swap' ? 'swap' : 'limit-ioc', hash);
          const outcome = await describeOutcome(receipt, v.kuru);
          const after = await snapshot();
          const delta = (k: number) => after.balances[k]!.free + after.balances[k]!.reserved - before.balances[k]!.free - before.balances[k]!.reserved;
          const quote = delta(0) < 0n ? -delta(0) : delta(0);
          const base = delta(1) < 0n ? -delta(1) : delta(1);
          trade!.outcome = outcome.label;
          trade!.fills = outcome.fills;
          trade!.claimsFilled = claimsOf(base);
          trade!.usdcMoved = usdcOf(quote);
          trade!.avgPrice = base > 0n ? Number((usdcOf(quote) / claimsOf(base)).toFixed(6)) : undefined;
          trade!.gasUsed = receipt.gasUsed.toString();
          trade!.status = base === 0n ? 'unfilled' : base < sizeAtoms && o.op === 'limit' && buy ? 'partial' : 'filled';
          say(`  wallet ${i + 1} ${plan.persona} ${trade!.market} ${o.side} ${o.op} ${trade!.status} ${trade!.claimsFilled} claims for ${trade!.usdcMoved} USDC`);
        }
      } catch (error) {
        failures++;
        if (trade) { trade.status = 'failed'; trade.note = describe(error).slice(0, 300); }
        say(`  wallet ${i + 1} ${step.op} failed: ${describe(error).slice(0, 200)}`);
        if (failures >= 2) break;
      }
    }
    await save(false);
  }

  if (args.sweep) await sweep(env, stored.slice(0, args.wallets), log, say, L!.claim, S!.claim, track);
  await save(true);
  const sent = trades.filter((t) => t.status !== 'skipped');
  say(`done: ${sent.length} trades, ${sent.filter((t) => (t.claimsFilled ?? 0) > 0).length} filled, evidence ${evidenceFile}`);
}

async function sweep(
  env: Env, wallets: StoredWallet[], log: Op[], say: (t?: string) => void, longClaim: Address, shortClaim: Address,
  trackIn?: (wallet: string, kind: string, hash: Hex) => Promise<unknown>,
) {
  const { pc, config } = env;
  const track = trackIn ?? (async (wallet: string, kind: string, hash: Hex) => {
    const [receipt, tx] = await Promise.all([confirmed(pc, hash), pc.getTransaction({ hash })]);
    log.push({ wallet, kind, hash, gasUsed: receipt.gasUsed, gasLimit: tx.gas, gasPrice: receipt.effectiveGasPrice });
  });
  const balanceOf = (token: Address, owner: Address) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const to = env.owner;
  for (const w of wallets) {
    const account = privateKeyToAccount(w.privateKey);
    const wc = createWalletClient({ account, chain: env.chain, transport: custom({ request: pc.request as never }) });
    const send = (address: Address, abi: typeof erc20Abi | typeof marketAbi, functionName: string, args: readonly unknown[]) =>
      wc.writeContract({ address, abi, functionName, args, chain: env.chain, account } as never);
    try {
      const session = await openSession(pc, wc, config.accountCore);
      const kuru = await readKuruAccount(pc, config.accountCore, w.address, [config.collateral, longClaim, shortClaim]);
      for (const b of kuru.balances) if (b.free > 0n) await track(w.address, 'sweep-withdraw', await withdrawFromKuru(session, b.token, b.free));
      const [l, s] = await Promise.all([balanceOf(longClaim, w.address), balanceOf(shortClaim, w.address)]);
      const pairs = l < s ? l : s;
      if (pairs > 0n) await track(w.address, 'sweep-mergePairs', await send(config.market, marketAbi, 'mergePairs', [pairs, to]));
      for (const [token, kind, left] of [[longClaim, 'sweep-claim', l - pairs], [shortClaim, 'sweep-claim', s - pairs]] as const) {
        if (left > 0n) await track(w.address, kind, await send(token, erc20Abi, 'transfer', [to, left]));
      }
      const usdc = await balanceOf(config.collateral, w.address);
      if (usdc > 0n) await track(w.address, 'sweep-usdc', await send(config.collateral, erc20Abi, 'transfer', [to, usdc]));
      const [balance, fees] = await Promise.all([pc.getBalance({ address: w.address }), pc.estimateFeesPerGas()]);
      const reserve = 21_000n * fees.maxFeePerGas!;
      if (balance > reserve) {
        await track(w.address, 'sweep-mon', await wc.sendTransaction({ to, value: balance - reserve, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, chain: env.chain, account }));
      }
      say(`  swept ${w.address}`);
    } catch (error) {
      say(`  sweep ${w.address} failed: ${describe(error).slice(0, 200)}`);
    }
  }
}

const num = (name: string, text: string, min: number) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n < min) fail(`--${name} must be a number >= ${min}`);
  return n;
};

export function parseArguments(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      network: { type: 'string', default: 'local' },
      wallets: { type: 'string', default: '8' },
      seed: { type: 'string', default: '7' },
      'mon-each': { type: 'string', default: '0.25' },
      'max-trades': { type: 'string', default: '50' },
      'max-usdc': { type: 'string', default: '1500' },
      'max-mon': { type: 'string', default: '3' },
      sweep: { type: 'boolean', default: false },
      'sweep-only': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: true },
      confirm: { type: 'boolean', default: false },
    },
    allowNegative: true,
    strict: true,
  });
  const seedArgs = ['--network', values.network!, ...(values['dry-run'] ? [] : ['--no-dry-run']), ...(values.confirm ? ['--confirm'] : [])];
  return {
    seedArgs,
    wallets: Math.floor(num('wallets', values.wallets!, 1)),
    seed: Math.floor(num('seed', values.seed!, 0)),
    monEach: num('mon-each', values['mon-each']!, 0),
    caps: { trades: num('max-trades', values['max-trades']!, 0), usdc: num('max-usdc', values['max-usdc']!, 0), mon: num('max-mon', values['max-mon']!, 0) },
    sweep: values.sweep!,
    sweepOnly: values['sweep-only']!,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const parsed = parseArguments(process.argv.slice(2));
    const env = await connect(parseOptions(parsed.seedArgs));
    try { await run(env, parsed); } finally { await env.stop(); }
  })().catch((error) => {
    console.error(error instanceof UsageError ? `error: ${error.message}` : `failed: ${describe(error)}`);
    process.exit(1);
  });
}
