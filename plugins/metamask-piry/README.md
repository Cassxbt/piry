# mm-plugin-piry

A MetaMask Agent Wallet plugin that lets an AI agent hedge its GPU rental bill with [Piry](../../README.md) claims on Monad testnet.

An agent that rents H100s pays a price that moves. Piry issues fully collateralized long and short ERC-20 claims on the Piry H100 Composite (the median USD price of one H100 SXM GPU-hour across Akash, RunPod, Verda and Shadeform). The plugin sizes a hedge in GPU-hours, buys the long claim on Kuru inside a spending cap, tracks the position, and redeems after settlement. Every transaction is proposed to the Agent Wallet, so MetaMask policy, threat scanning and 2FA apply.

Live series (Monad testnet, chain 10143): band $2.50 to $4.50 per GPU-hour, collateral Kuru test USDC, settles 2026-10-19 12:00 UTC. One long claim pays `(index - 2.5) / 2` USDC at settlement, clamped to 0 to 1.

## Commands

| Command | Capabilities | What it does |
| --- | --- | --- |
| `mm piry quote [--gpu-hours N] [--sources]` | none | Live index from the on-chain mark feed, band, settlement countdown, claims needed for N GPU-hours with payout scenarios, Kuru price if listed. `--sources` also reads the four public sources live. Works before login. |
| `mm piry hedge --gpu-hours N [--max-premium USDC] [--slippage bps]` | wallet-read, wallet-submit | Buys PIRY-L on Kuru: approve, deposit, swap with a minimum-out floor, withdraw. Without `--max-premium` it only previews. |
| `mm piry position [--owner 0x..]` | wallet-read | Claims in the wallet and the Kuru trading balance, value at the mark, covered GPU-hours, settlement status. |
| `mm piry unwind [--claims N] [--method auto\|merge\|sell] [--min-proceeds USDC]` | wallet-read, wallet-submit | Merge PIRY-L and PIRY-S pairs back to USDC, then sell the rest on Kuru above a proceeds floor. |
| `mm piry redeem [--min-payout USDC]` | wallet-read, wallet-submit | After settlement: withdraw from Kuru if needed and redeem. The default floor is the contract's own previewed payout. |

All commands accept the host flags `--json`, `--format`, `--toon`, `--verbose`.

Sizing: claims = GPU-hours x (upper - lower). With the live band, 500 GPU-hours need 1,000 claims, whose maximum payout is 1,000 USDC. The hedge pays nothing at or below $2.50 and stops growing at $4.50; it is a capped cash-settled hedge, not a reimbursement.

If no PIRY-L market is configured (for example `PIRY_KURU_MARKET=""`), `hedge` reports `UNAVAILABLE` and sends nothing. With `--allow-mint` it mints pairs instead (1 USDC of collateral per claim), then sells the PIRY-S leg on the PIRY-S Kuru market if one is configured, or sends it to `--short-to`. If neither applies it reports `UNHEDGED_PAIR`: both legs are held and net exposure is flat.

## Safety model

- No signing path. The plugin has no key, mnemonic or session access (the host denies them) and imports no signing code. The only write route is `ctx.walletExecutor`, which applies MetaMask policy. A test fails if any source file references a signing or broadcasting API, or if anything other than `src/base.ts` touches the executor.
- Least privilege. `quote` declares no capability and `position` only `wallet-read`; only `hedge`, `unwind` and `redeem` declare `wallet-submit`. The plugin-wide capability list is empty. Every command targets chain 10143 only.
- Caps are enforced in the plugin, before a step reaches the wallet. The spend of each step is checked against `--max-premium` first; a breach throws `CAP_EXCEEDED` with nothing sent for that step. The order size is also bounded by the cap when it is computed.
- Price guards. Buys and sales carry a minimum-out computed from the market's own `estimateSwap` and `--slippage` (default 100 bps, refused above 1000). `unwind --min-proceeds` and `redeem --min-payout` refuse bad prices. `redeem` also refuses to send if the contract's `previewRedeem` disagrees with the plugin's payout math.
- Markets are verified on chain before use: AccountCore must list it as a verified spot order book, and its base token, quote token and active state must match PIRY-L and Kuru test USDC, otherwise `KURU_MARKET_MISMATCH`. The Piry contracts are cross-checked against what the market contract reports (`SERIES_MISMATCH`), as is the chain id.
- Preview by default. `hedge` without `--max-premium` sends nothing.
- Failures report where funds are. If a step fails after earlier ones landed (for example USDC already deposited into Kuru) the error names the completed steps and points to `mm piry position`.
- Reads use the public Monad RPC (`https://testnet-rpc.monad.xyz`, override with `PIRY_RPC_URL`, https or loopback only). Nothing is written to disk.

## Install

Requires `mm` 6.2.0 or newer and Node 22.18+. Installed and run on `mm` 7.1.0; the manifest range `>=6.2.0 <8.0.0` is checked against 6.2.0, 6.2.1, 7.0.0 and 7.1.0 in the tests (the template's `^6.2.0` would be refused by 7.x). Plugins are a beta feature.

```bash
cd plugins/metamask-piry
npm ci
npm run build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true      # local install only
mm plugins install "file:$PWD" --accept-permissions         # review the consent screen instead if you prefer
mm piry quote
```

Install from the directory, not a tarball. Installing from npm currently fails on some `mm` versions ([template issue 4](https://github.com/MetaMask/agent-wallet-plugin-template/issues/4)), so the demo uses `file:`. To publish, remove `"private": true` first. Give the agent the skill by copying `skills/piry/` into its skills directory.

Configuration (all optional; the live Kuru markets are built in): `PIRY_KURU_MARKET` / `--kuru-market` overrides the PIRY-L/USDC order book (default `0xe2393d5f15523931e59f340cffebcde30fa7db1a`), `PIRY_KURU_SHORT_MARKET` / `--kuru-short-market` overrides PIRY-S/USDC (default `0xd93db02c88d645e669a3965cd46e72cca137f193`), `PIRY_RPC_URL` overrides the read RPC. An explicitly empty value disables that market.

## Real-wallet prerequisites

1. `mm login` then `mm init --wallet server-wallet --mode guard` (or `--wallet byok`). `mm doctor` must show `authenticated: true`, `initialized: true`.
2. Fund the wallet address (`mm wallet address`) on Monad testnet with MON for gas and Kuru test USDC (`0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1`) at least equal to the cap.
3. Make `mm` able to submit on chain 10143. On `mm` 7 the host's gateway answers `Invalid chainId` for Monad testnet. Reported workaround ([issue 6](https://github.com/MetaMask/agent-wallet-plugin-template/issues/6)): with no `mm` command running, add to `~/.metamask/wallets.json` under `data.customEvmChains`:
   ```json
   { "key": "monad-testnet", "chainId": 10143, "caip2": "eip155:10143", "name": "Monad Testnet",
     "nativeCurrency": { "name": "Monad", "symbol": "MON", "decimals": 18 },
     "blockExplorer": "https://testnet.monadscan.com", "rpcTarget": "https://testnet-rpc.monad.xyz" }
   ```
   The plugin maps this failure to `MM_CHAIN_RPC_UNAVAILABLE` with the same hint.
4. Guard Mode policy: allow network 10143 and allowlist the addresses the hedge touches, and set an outflow limit at or above the cap. See `mm wallet policy template` for the field names. Addresses: Piry market `0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538`, collateral `0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1`, PIRY-L `0x7D4B1319648B1f2478495Dcce10313Cd045Ef997`, PIRY-S `0xF3ACA854B4e0626CDedd391eC1396DBde6820d48`, Kuru AccountCore `0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038`, plus the two Kuru order books: PIRY-L/USDC `0xe2393d5f15523931e59f340cffebcde30fa7db1a` and PIRY-S/USDC `0xd93db02c88d645e669a3965cd46e72cca137f193`. Anything outside the allowlists pauses for 2FA, which is also a fine demo moment.

## Demo script (about 5 minutes)

Setup before recording: steps 1 to 4 above and the plugin installed. The Kuru markets are built in.

| Time | Say and show |
| --- | --- |
| 0:00 | "My agent rents H100s at about $3.41 an hour. If that rises, its bill rises." `mm plugins` and `mm piry --help`: the plugin is installed, consent screen showed exactly which commands can submit. |
| 0:30 | `mm piry quote --gpu-hours 500 --sources`. The on-chain index and the four live sources agree; 500 GPU-hours need 1,000 claims; the scenario table shows the payout rising to the $4.50 cap and what stays uncovered above it. |
| 1:15 | `mm piry hedge --gpu-hours 500`. Preview only: spend, expected claims, the slippage floor, average price. Nothing sent. |
| 2:00 | `mm piry hedge --gpu-hours 500 --max-premium 500 --slippage 100`. Show the intents in the Agent Wallet, the 2FA prompt for anything outside the allowlist, then the four steps landing (approve, deposit, swap, withdraw) and `status: HEDGED`. To show the fallback, set `PIRY_KURU_MARKET=""` to get `UNAVAILABLE`, then re-run with `--allow-mint`, which sells the PIRY-S leg on the built-in PIRY-S market. |
| 3:15 | Re-run with a cap that is too small: the plugin trims the order to the cap and reports `PARTIAL`; it never exceeds it. |
| 3:45 | `mm piry position`: claims in wallet and Kuru, value at the mark, covered GPU-hours, countdown. |
| 4:15 | `mm piry redeem` before settlement: refused with the countdown and the 7-day permissionless fallback. After settlement (or on a fast-demo series) the same command withdraws and redeems above the previewed floor. |
| 4:45 | Close: every write went through the Agent Wallet; the plugin cannot sign; the cap and the price floors are enforced before anything is sent. |

## Develop

```bash
npm run typecheck      # src and tests
npm test               # 51 offline tests (4 live tests are skipped)
PIRY_LIVE=1 npm test   # also runs 4 read-only checks against Monad testnet; the wallet in them throws if anything tries to send
```

`test/sim.ts` is a small chain simulator: the mocked Agent Wallet decodes the exact calldata the plugin proposes (Piry market, ERC-20, Kuru AccountCore and order book) and applies it, so the flows are tested end to end without a network.

Layout: `src/commands/piry/*` are thin oclif commands; `src/hedge.ts`, `unwind.ts`, `redeem.ts`, `position.ts`, `quote.ts` hold the flows; `kuru.ts` encodes Kuru V2 calls with `@toxicflow-labs/ts-sdk` request builders; `math.ts` mirrors `PayoutMath` floor semantics; `sources.ts` ports the composite index's four source rules; `tx.ts` holds the budgeted step runner.

## Limits

- Testnet only, test tokens, unaudited.
- The PIRY-L and PIRY-S Kuru markets exist and are the plugin defaults. `mm piry quote` reads the live PIRY-L book (best ask, cost to buy the hedge). The write flows (hedge, unwind, redeem) are tested against a calldata-decoding simulator and have not been submitted through a real Agent Wallet.
- Real-wallet submission on chain 10143 depends on the host fix above and was not run.
- Both books are seeded by the Piry team; liquidity is thin and not organic.
- PIRY-S held inside Kuru is not merged automatically by `unwind`; withdraw it first.
