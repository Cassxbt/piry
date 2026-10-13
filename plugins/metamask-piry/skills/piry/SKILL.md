---
name: piry
description: Use when an AI agent pays for GPU compute (Akash, RunPod, Verda, Shadeform or similar) and its human wants protection against the H100 rental price rising before a known date. Hedges GPU-hour spend from the MetaMask Agent Wallet by buying capped Piry long claims (PIRY-L) on Monad testnet through the `mm piry` plugin commands, always inside a spending cap the human approved. Also covers checking the live H100 index, reading the hedge position, closing it early, and redeeming after settlement.
---

# Piry: hedge next month's GPU bill from the Agent Wallet

Piry issues fully collateralized, capped long and short claims on the Piry H100 Composite, the median USD price of one H100 SXM GPU-hour across Akash, RunPod, Verda and Shadeform. One PIRY-L claim pays between 0 and 1 USDC at settlement: `(index - lower) / (upper - lower)`, clamped. Live series: band $2.50 to $4.50, settles 2026-10-19 12:00 UTC, Monad testnet (chain 10143), collateral Kuru test USDC.

This is a cash-settled hedge, not a reimbursement. It does not reserve compute, and it covers only the part of a price rise inside the band.

## Rules (read first)

1. Every transaction goes through the Agent Wallet, so MetaMask policy, threat scanning and 2FA still apply. Never try to sign or send around it.
2. Never spend without a cap the human approved in this conversation. Pass it as `--max-premium <USDC>`. Do not raise it on your own, and do not re-run a command with a bigger cap to "finish the job".
3. Run `quote` and `hedge` without `--max-premium` (preview) first, show the human the plan, and wait for an explicit yes before the executing call.
4. If a command stops with `[AWAITING_MFA]`, tell the human to approve in MetaMask and stop. Do not resubmit.
5. After any failed or interrupted write, do not retry. Run `mm piry position`: earlier steps may already have moved funds (for example USDC deposited into the Kuru trading balance).
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

1. Size it. `mm piry quote --gpu-hours <N> --json` returns the live index, the band, the claims needed and what they would pay at several index levels.
   - Claims = GPU-hours x (upper - lower). With the live band, 1 GPU-hour needs 2 claims; 500 GPU-hours need 1,000 claims.
   - Maximum payout equals the number of claims in USDC, reached when the index is at or above the upper bound.
   - `fairPremiumAtMarkUsdc` is claims x the current mark, a sanity check on the price Kuru quotes.
2. Explain the limits to the human: nothing is paid at or below $2.50, the payout stops growing at $4.50, and the premium is lost if the index settles low.
3. Preview. `mm piry hedge --gpu-hours <N> --json` sends nothing and shows spend, expected claims, the minimum claims after slippage, and the average price.
4. Execute with the approved cap. `mm piry hedge --gpu-hours <N> --max-premium <USDC> --slippage 100 --json` (100 bps = 1%, the plugin refuses more than 1000). It approves USDC, deposits into Kuru, swaps with a minimum-out floor, and withdraws the claims to the wallet.
   - `status: HEDGED` means net long claims cover the target. `PARTIAL` means the cap or the order book depth limited it; report the shortfall and ask before doing more.
   - `UNAVAILABLE` means Kuru has not listed PIRY-L yet. Tell the human; do not mint unless they agree (rule 6).
5. Monitor. `mm piry position --json` shows claims in the wallet and the Kuru trading balance, value at the mark, covered GPU-hours, and settlement status. A stale mark (over one hour) is flagged.
6. Close early if asked. `mm piry unwind --json` merges PIRY-L with PIRY-S back into USDC, then sells the rest on Kuru. Use `--min-proceeds <USDC>` to refuse a bad price.
7. After settlement: `mm piry redeem --json` withdraws from Kuru if needed and redeems with a minimum-payout guard equal to the contract's own preview. If the oracle never delivers, anyone can settle at the band midpoint 7 days after the period ends; `redeem` says when.

## Status and error codes

| Code or status | Meaning | What to do |
| --- | --- | --- |
| `CAP_EXCEEDED` | A step would pass `--max-premium`; nothing was sent for it | Ask the human; never raise silently |
| `KURU_MARKET_MISMATCH` | The configured Kuru market is not PIRY-L/USDC | Stop; get the right address |
| `SERIES_MISMATCH`, `WRONG_CHAIN` | Contracts or RPC differ from what the plugin expects | Stop and report |
| `SERIES_CLOSED` | Period over or settled | Use `position`, then `redeem` |
| `INSUFFICIENT_BALANCE` | Not enough USDC | Ask the human to fund; nothing was sent |
| `PROCEEDS_BELOW_MIN`, `PAYOUT_BELOW_MIN` | Price guard tripped | Wait or lower the floor with approval |
| `NOT_SETTLED` | Cannot redeem yet | Wait; the message gives the countdown |
| `PREVIEW_MISMATCH` | The contract's payout differs from the plugin's math | Stop and report |
| `MM_CHAIN_RPC_UNAVAILABLE` | Host cannot reach chain 10143 | See Setup |

## Configuration

`PIRY_KURU_MARKET` / `--kuru-market`: the PIRY-L/USDC order book. `PIRY_KURU_SHORT_MARKET` / `--kuru-short-market`: the PIRY-S/USDC order book, used only to sell the short leg when minting. `PIRY_RPC_URL`: read-only RPC override (https, or loopback http). The plugin verifies each market's base and quote tokens on chain before using it.
