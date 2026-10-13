// Offline tests for the plan and cap logic of scripts/test-trades.ts: bun test scripts/test-trades.test.ts
import { expect, test } from 'bun:test';

import { buildPlans, capIssues, parseArguments } from './test-trades.ts';

const price = { L: 0.4542, S: 0.5457 };
const caps = { trades: 50, usdc: 1500, mon: 3 };
const orders = (plans: ReturnType<typeof buildPlans>) => plans.flatMap((p) => p.steps.flatMap((s) => ('usdc' in s ? [s] : [])));

test('the same seed gives the same plan and the default plan respects every cap', () => {
  const plans = buildPlans(8, 7, price);
  expect(buildPlans(8, 7, price)).toEqual(plans);
  expect(buildPlans(8, 8, price)).not.toEqual(plans);
  expect(capIssues(plans, 0.25, caps)).toEqual([]);
  expect(new Set(plans.map((p) => p.persona)).size).toBe(5);
  for (const t of orders(plans)) expect(t.usdc).toBeGreaterThanOrEqual(2);
  expect(orders(plans).every((t) => t.usdc <= 60)).toBe(true);
});

test('plans that exceed a cap are refused', () => {
  const plans = buildPlans(8, 7, price);
  expect(capIssues(plans, 0.25, { ...caps, trades: 5 })[0]).toContain('trades');
  expect(capIssues(plans, 0.25, { ...caps, usdc: 100 })[0]).toContain('USDC');
  expect(capIssues(plans, 0.5, { ...caps, mon: 3 })[0]).toContain('MON');
  expect(capIssues(buildPlans(30, 7, price), 0.05, caps).some((m) => m.includes('trades'))).toBe(true);
});

test('arguments default to a local dry run', () => {
  const a = parseArguments([]);
  expect(a.seedArgs).toEqual(['--network', 'local']);
  expect(parseArguments(['--network', 'monad-testnet', '--no-dry-run', '--confirm']).seedArgs).toEqual(['--network', 'monad-testnet', '--no-dry-run', '--confirm']);
});
