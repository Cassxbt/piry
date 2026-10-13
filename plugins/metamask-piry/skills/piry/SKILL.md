---
name: piry
description: Use when an AI agent pays for GPU compute (Akash, RunPod, Verda, Shadeform or similar) and its human wants protection against the H100 rental price rising before a known date. Hedges GPU-hour spend from the MetaMask Agent Wallet by buying capped Piry long claims (PIRY-L) on Monad testnet through the `mm piry` plugin commands, always inside a spending cap the human approved. Also covers checking the live H100 index, reading the hedge position, closing it early, and redeeming after settlement.
---

# Piry: hedge next month's GPU bill from the Agent Wallet

Piry issues fully collateralized, capped long and short claims on the Piry H100 Composite, the median USD price of one H100 SXM GPU-hour across Akash, RunPod, Verda and Shadeform. One PIRY-L claim pays between 0 and 1 USDC at settlement: `(index - lower) / (upper - lower)`, clamped. Live series: band $2.50 to $4.50, settles 2026-10-19 12:00 UTC, Monad testnet (chain 10143), collateral Kuru test USDC.

This is a cash-settled hedge, not a reimbursement. It does not reserve compute, and it covers only the part of a price rise inside the band.

What the plugin itself checks, locally: preview first (no `--max-premium`, nothing is sent), the `--max-premium` cap on each step, the Kuru market's minimum notional, a stale-price preflight through Kuru's withdrawal limiter (a point-in-time check), a verified Kuru book (AccountCore lists it and its tokens match), refusal once the series is settled, and mined-success confirmation of every step. It does not promise per-transaction policy enforcement by the wallet.

## Rules (read first)

1. Every transaction is submitted through the Agent Wallet host; the plugin holds no keys. Never try to sign or send around it. Do not assume the wallet's Guard policy will stop a bad transaction on Monad testnet: in our 13 Oct test Guard's allowlist and outflow limit did not block transfers on chain 10143 (changing the policy did need email MFA). The controls you can rely on are the plugin's own checks and the human's approval in this conversation.
2. Never spend without a cap the human approved in this conversation. Pass it as `--max-premium <USDC>`. Do not raise it on your own, and do not re-run a command with a bigger cap to "finish the job". The cap bounds one `mm piry` purchase, not the wallet.
3. Run `quote` and `hedge` without `--max-premium` (preview) first, show the human the plan, and wait for an explicit yes before the executing call.
4. If a command stops with `[AWAITING_MFA]`, tell the human to approve in MetaMask and stop. Do not resubmit.
5. After any failed, uncertain or interrupted write, do not retry. The error lists every submitted hash and marks the step `FAILED` or `UNCERTAIN` (an UNCERTAIN transaction may still land). Run `mm piry position`: earlier steps may already have moved funds (for example USDC deposited into the Kuru trading balance). Later steps are never sent after one fails.
6. Do not use `--allow-mint` unless the human agrees to lock 1 USDC of collateral per claim. Say plainly that without a PIRY-S buyer the hedge is not active.
7. Use `--json` and parse the result. Read `status`, `warnings` and `next`; relay warnings to the human.
8. Testnet only. Funds are test tokens.

## Setup (once)

```bash
mm doctor                                   # authenticated: true, initialized: true
mm config set experimentalPlugins true
mm piry quote                               # read-only; works before login
```

The wallet needs MON for gas and Kuru test USDC on chain 10143. If a write fails with `MM_CHAIN_RPC_UNAVAILABLE` the host does not know the chain's RPC: tell the human to add chain 10143 with `rpcTarget` `https://testnet-rpc.monad.xyz` (see the plugin README); nothing was sent.

## Workflow

1. Size it. `mm piry quote --gpu-hours <N> --json` returns the last on-chain mark (`kind: PREVIEW`, read-only), the band, the claims needed and what they would pay at several index levels. With `--sources` it also fetches the four public sources itself; that `liveSources` block is a preview, not the accepted on-chain observation.
   - Claims = GPU-hours x (upper - lower). With the live band, 1 GPU-hour needs 2 claims; 500 GPU-hours need 1,000 claims.
   - Maximum payout equals the number of claims in USDC, reached when the index is at or above the upper bound.
   - `fairPremiumAtMarkUsdc` is claims x the current mark, a sanity check on the price Kuru quotes.
2. Explain the limits to the human: nothing is paid at or below $2.50, the payout stops growing at $4.50, and the premium is lost if the index settles low.
3. Preview. `mm piry hedge --gpu-hours <N> --json` sends nothing and shows spend, expected claims, the minimum claims after slippage, and the average price.
4. Execute with the approved cap. `mm piry hedge --gpu-hours <N> --max-premium <USDC> --slippage 100 --json` (100 bps = 1%, the plugin refuses more than 1000). It approves USDC, deposits into Kuru, swaps with a minimum-out floor, and withdraws the claims to the wallet. It then re-reads every balance.
   - `status: HEDGED` means net coverage (wallet plus free Kuru balance, the same number `position` shows) reached the target. `PARTIAL` means the cap, the book depth or a partial fill left it short: report `after.netLong` against `targetClaims` and the `reconciliation` block (requested, used and unspent quote; leftover balances and where they are; `recovery` steps), then run `mm piry position` and preview again. Do not re-run the executing command, and ask the human before any further spend.
   - Real example (13 Oct): `hedge --gpu-hours 20 --max-premium 20` needed 40 claims, bought 39 PIRY-L for 18.085 USDC and ended `PARTIAL`. Expect `PARTIAL` on larger requests: the books are thin.
   - `UNAVAILABLE` means no PIRY-L Kuru market is configured (the live market is built in, so this only happens if it was disabled). Tell the human; do not mint unless they agree (rule 6).
5. Monitor. `mm piry position --json` shows claims in the wallet and the Kuru trading balance, value at the mark, covered GPU-hours, and settlement status. A mark older than 1,500 s (25 minutes) is flagged stale.
6. Close early if asked. `mm piry unwind --json` merges PIRY-L with PIRY-S back into USDC, then sells the rest on Kuru. Use `--min-proceeds <USDC>` to refuse a bad price: it is one floor over the merge payout plus the Kuru sale, checked before anything is sent.
7. After settlement: `mm piry redeem --json` redeems with a minimum-payout guard equal to the contract's own preview; wallet-held claims redeem even if a Kuru book is broken, and it withdraws from the Kuru account only when claims are parked there. If the oracle never delivers, anyone can settle at the band midpoint 7 days after the period ends; `redeem` says when.

## Status and error codes

| Code or status | Meaning | What to do |
| --- | --- | --- |
| `TRANSACTION_FAILED` | A step failed or reverted; its hash and every earlier hash are in the message | Do not retry. Run `position`, tell the human |
| `TRANSACTION_UNCERTAIN` | A step was submitted but not confirmed mined; it may still land | Do not retry or resubmit. Check the hashes and `position` later |
| `CAP_EXCEEDED` | A step would pass `--max-premium`; nothing was sent for it | Ask the human; never raise silently |
| `KURU_MARKET_MISMATCH` | The configured Kuru market is not PIRY-L/USDC | Stop; get the right address |
| `PRICE_STALE`, `PRICE_CHECK_FAILED` | Kuru's withdrawal limiter says the PIRY price is older than 1800 s (or could not be checked) | Wait a few minutes and retry; nothing was sent |
| `BELOW_MIN_NOTIONAL` | The buy is under the Kuru market's minimum order size | Ask for more GPU-hours or raise `--max-premium` |
| `WALLET_NOT_RESOLVED` | The host's selected wallet is not an EVM wallet the plugin can resolve | Select an EVM wallet, then retry |
| `SERIES_MISMATCH`, `WRONG_CHAIN` | Contracts or RPC differ from what the plugin expects | Stop and report |
| `SERIES_CLOSED` | Period over or settled | Use `position`, then `redeem` |
| `INSUFFICIENT_BALANCE` | Not enough USDC | Ask the human to fund; nothing was sent |
| `PROCEEDS_BELOW_MIN`, `PAYOUT_BELOW_MIN` | Price guard tripped (the proceeds floor is merge plus sale in total) | Wait or lower the floor with approval |
| `NOT_SETTLED` | Cannot redeem yet | Wait; the message gives the countdown |
| `PREVIEW_MISMATCH` | The contract's payout differs from the plugin's math | Stop and report |
| `MM_CHAIN_RPC_UNAVAILABLE` | Host cannot reach chain 10143 | See Setup |

## Configuration

The live Kuru markets are built in (PIRY-L/USDC `0xe2393d5f15523931e59f340cffebcde30fa7db1a`, PIRY-S/USDC `0xd93db02c88d645e669a3965cd46e72cca137f193`); the variables below override them and an empty value disables a market.

`PIRY_KURU_MARKET` / `--kuru-market`: the PIRY-L/USDC order book. `PIRY_KURU_SHORT_MARKET` / `--kuru-short-market`: the PIRY-S/USDC order book, used only to sell the short leg when minting. `PIRY_RPC_URL`: read-only RPC override (https, or loopback http). The plugin verifies each market's base and quote tokens on chain before using it.
