import type { Address } from "viem";
import { readAllowance } from "./chain.js";
import { SWAP_DEADLINE_SECONDS, type Deps } from "./context.js";
import { PiryError } from "./errors.js";
import { balanceOf, depositTx, estimateSwap, readAccount, swapTx, withdrawTx, type KuruMarket } from "./kuru.js";
import { fmt, slippageFloor } from "./math.js";
import { approveTx, type Run } from "./tx.js";

export interface SalePlan {
  amount: bigint;
  expected: bigint;
  minOut: bigint;
}

// What the book can absorb right now and the proceeds floor for it. Read-only. `minProceeds` is a total floor for the
// whole operation; `secured` is what the same operation already guarantees elsewhere (merged pairs), so the sale only
// has to cover the difference.
export async function planSale(deps: Deps, market: KuruMarket, rootId: bigint, amount: bigint, slippageBps: number, minProceeds: bigint | null, decimals: number, secured = 0n): Promise<SalePlan> {
  const est = await estimateSwap(deps.client, market.address, false, amount, rootId);
  const sellable = est.amountInUsed < amount ? est.amountInUsed : amount;
  let minOut = slippageFloor(est.amountOut, slippageBps);
  if (minProceeds !== null) {
    if (secured + est.amountOut < minProceeds) {
      const total = secured > 0n ? ` on top of ${fmt(secured, decimals)} USDC from merging, ${fmt(secured + est.amountOut, decimals)} USDC in total` : "";
      throw new PiryError("PROCEEDS_BELOW_MIN", `Selling now would return about ${fmt(est.amountOut, decimals)} USDC${total}, below the minimum of ${fmt(minProceeds, decimals)}. Nothing was sent.`, "Wait, lower --min-proceeds, or merge pairs instead.");
    }
    if (minProceeds > secured && minProceeds - secured > minOut) minOut = minProceeds - secured;
  }
  return { amount: sellable, expected: est.amountOut, minOut };
}

// Deposit the claim into the Kuru trading balance, sell it for USDC with a floor, and withdraw the USDC. Returns the USDC received.
export async function executeSale(deps: Deps, run: Run, market: KuruMarket, token: Address, label: string, plan: SalePlan, now: bigint, decimals: number, fromWallet: bigint): Promise<bigint> {
  const { client, config, wallet } = deps;
  const { collateral } = config.series;
  const owner = wallet.address;
  if (fromWallet > 0n) {
    if ((await readAllowance(client, token, owner, config.accountCore)) < fromWallet) {
      await run.send(`approve-${label}`, `Piry: let Kuru take ${fmt(fromWallet, decimals)} ${label} to sell`, approveTx(token, config.accountCore, fromWallet));
    }
    await run.send(`deposit-${label}`, `Piry: deposit ${fmt(fromWallet, decimals)} ${label} into your Kuru trading balance`, depositTx(config.accountCore, owner, token, fromWallet));
  }
  const before = await readAccount(client, config.accountCore, owner, [collateral]);
  if (before.rootId === 0n) throw new PiryError("KURU_ACCOUNT_MISSING", "No Kuru account exists for this wallet after the deposit.", "Run `mm piry position` before retrying.");
  await run.send(
    `sell-${label}`,
    `Piry: sell ${fmt(plan.amount, decimals)} ${label} on Kuru for at least ${fmt(plan.minOut, decimals)} USDC`,
    swapTx(market.address, before.rootId, false, plan.amount, plan.minOut, now + SWAP_DEADLINE_SECONDS),
  );
  const after = await readAccount(client, config.accountCore, owner, [collateral]);
  const proceeds = balanceOf(after, collateral).free - balanceOf(before, collateral).free;
  if (proceeds > 0n) {
    await run.send(`withdraw-usdc`, `Piry: withdraw ${fmt(proceeds, decimals)} USDC from Kuru to your wallet`, withdrawTx(config.accountCore, before.rootId, collateral, proceeds, owner));
  }
  return proceeds > 0n ? proceeds : 0n;
}
