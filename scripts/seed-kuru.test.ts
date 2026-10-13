// Fork test for scripts/seed-kuru.ts: bun test scripts/seed-kuru.test.ts (needs anvil and network access to read Monad testnet).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWalletClient, erc20Abi, getAddress, http, numberToHex, type Address } from 'viem';

import { estimateSwap, openSession, placeSwap, readKuruAccount, readKuruBook, readOpenOrders, confirmed, depositToKuru } from '../app/src/lib/kuru.ts';
import { cancelOwn, connect, parseOptions, seed, type Env } from './seed-kuru.ts';

const TAKER = getAddress('0x000000000000000000000000000000000000ca55');
let env: Env;

beforeAll(async () => {
  delete process.env.LOCAL_RPC_URL;
  env = await connect(parseOptions(['--no-dry-run']));
}, 120_000);
afterAll(async () => { await env?.stop(); });

const ownCount = async (market: Address) => {
  const account = await readKuruAccount(env.pc, env.config.accountCore, env.owner, []);
  return (await readOpenOrders(env.pc, market, account.rootId, env.config.accountCore)).length;
};

test('seeds both books, fills a taker swap, re-runs idempotently, cancels', async () => {
  const [long, short] = env.config.venues;
  const nonceBefore = await env.pc.getTransactionCount({ address: env.owner });

  const dry = await seed({ ...env, options: { ...env.options, dryRun: true } });
  expect(dry.txs).toHaveLength(0);
  expect(await env.pc.getTransactionCount({ address: env.owner })).toBe(nonceBefore);

  const first = await seed(env);
  for (const v of first.venues) {
    expect(v.ownOrders).toBe(10);
    expect(v.missing).toBe(0);
  }

  await env.pc.request({ method: 'anvil_impersonateAccount', params: [TAKER] } as never);
  await env.pc.request({ method: 'anvil_setBalance', params: [TAKER, numberToHex(10n ** 18n)] } as never);
  const transfer = await env.wallet!.writeContract({ address: env.config.collateral, abi: erc20Abi, functionName: 'transfer', args: [TAKER, 200_000_000n], chain: env.chain, account: env.owner });
  await confirmed(env.pc, transfer);
  const url = env.chain.rpcUrls.default.http[0]!;
  const taker = await openSession(env.pc, createWalletClient({ account: TAKER, chain: env.chain, transport: http(url) }), env.config.accountCore);
  await confirmed(env.pc, await depositToKuru(taker, env.config.collateral, 200_000_000n));
  const takerRoot = await taker.account.getRootAccountId({ rootOwner: TAKER });

  const before = await readKuruBook(env.pc, long!.kuru, 20);
  const bestAsk = before.asks.reduce((m, l) => (l.priceRaw < m.priceRaw ? l : m));
  const estimate = await estimateSwap(env.pc, long!.kuru, true, 100_000_000n, takerRoot);
  expect(estimate.amountOut).toBeGreaterThan(0n);
  await confirmed(env.pc, await placeSwap(taker, { market: long!.kuru, rootId: takerRoot, isBuy: true, amountIn: 100_000_000n, minAmountOut: estimate.amountOut * 99n / 100n }));
  const bought = (await readKuruAccount(env.pc, env.config.accountCore, TAKER, [long!.claim])).balances[0]!.free;
  console.log(`taker swap: 100 USDC -> ${bought} PIRY-L at best ask ${bestAsk.priceRaw} (estimate ${estimate.amountOut})`);
  expect(bought).toBe(estimate.amountOut);
  const after = await readKuruBook(env.pc, long!.kuru, 20);
  const askAfter = after.asks.find((l) => l.priceRaw === bestAsk.priceRaw)?.sizeRaw ?? 0n;
  expect(askAfter).toBeLessThan(bestAsk.sizeRaw);
  console.log(`best ask level ${bestAsk.priceRaw}: ${bestAsk.sizeRaw} -> ${askAfter}`);

  const second = await seed(env);
  console.log('re-run txs:', second.txs.map((t) => t.label));
  for (const v of second.venues) {
    expect(v.ownOrders).toBe(10);
    expect(v.missing).toBe(0);
  }
  expect(second.txs.some((t) => t.label.startsWith('cancel'))).toBe(true);

  const cancelled = await cancelOwn(env);
  expect(cancelled).toBe(20);
  expect(await ownCount(long!.kuru)).toBe(0);
  expect(await ownCount(short!.kuru)).toBe(0);
  for (const v of env.config.venues) {
    const book = await readKuruBook(env.pc, v.kuru, 20);
    expect(book.bids).toHaveLength(0);
    expect(book.asks).toHaveLength(0);
  }
}, 600_000);
