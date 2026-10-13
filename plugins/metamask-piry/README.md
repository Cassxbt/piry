# mm-plugin-piry

A MetaMask Agent Wallet plugin that lets an AI agent hedge its GPU rental bill with [Piry](../../README.md) claims on Monad testnet.

An agent that rents H100s pays a price that moves. Piry issues fully collateralized long and short ERC-20 claims on the Piry H100 Composite (the median USD price of one H100 SXM GPU-hour across Akash, RunPod, Verda and Shadeform). The plugin sizes a hedge in GPU-hours, buys the long claim on Kuru inside a spending cap, tracks the position, and redeems after settlement. Every transaction is submitted through the Agent Wallet host and the plugin handles no keys. What the plugin checks itself, and what it does not promise about the wallet's policy, is spelled out under [Safety model](#safety-model).

Live series (Monad testnet, chain 10143): band $2.50 to $4.50 per GPU-hour, collateral Kuru test USDC, settles 2026-10-19 12:00 UTC. One long claim pays `(index - 2.5) / 2` USDC at settlement, clamped to 0 to 1.

## Commands

| Command | Capabilities | What it does |
| --- | --- | --- |
| `mm piry quote [--gpu-hours N] [--sources]` | none | The last on-chain mark, band, settlement countdown, claims needed for N GPU-hours with payout scenarios, Kuru price if listed. The output is a read-only PREVIEW. `--sources` also reads the four public sources live under the workflow's rules; that block is labelled a preview too, not the accepted on-chain observation. Works before login. |
| `mm piry hedge --gpu-hours N [--max-premium USDC] [--slippage bps]` | wallet-read, wallet-submit | Buys PIRY-L on Kuru: approve, deposit, swap with a minimum-out floor, withdraw. Without `--max-premium` it only previews. After a write it re-reads every balance and reports `HEDGED` only if net coverage reaches the request; otherwise `PARTIAL`, with requested, used and unspent quote, leftovers and recovery steps in `reconciliation`. |
| `mm piry position [--owner 0x..]` | wallet-read | Claims in the wallet and the Kuru trading balance, value at the mark, covered GPU-hours, settlement status. Net coverage here is the number `hedge` reports. |
| `mm piry unwind [--claims N] [--method auto\|merge\|sell] [--min-proceeds USDC]` | wallet-read, wallet-submit | Merge PIRY-L and PIRY-S pairs back to USDC, then sell the rest on Kuru. `--min-proceeds` is one floor over the merge payout plus the sale, checked before any write; the summary shows both parts and the USDC actually received. |
| `mm piry redeem [--min-payout USDC]` | wallet-read, wallet-submit | After settlement: redeem with the contract's own previewed payout as the floor. Wallet-held claims redeem without reading either Kuru order book; Kuru is touched only to withdraw claims held in your Kuru account. |

All commands accept the host flags `--json`, `--format`, `--toon`, `--verbose`.

Sizing: claims = GPU-hours x (upper - lower). With the live band, 20 GPU-hours need 40 claims and 500 GPU-hours need 1,000 claims, whose maximum payout is 1,000 USDC. The hedge pays nothing at or below $2.50 and stops growing at $4.50; it is a capped cash-settled hedge, not a reimbursement.

If no PIRY-L market is configured (for example `PIRY_KURU_MARKET=""`), `hedge` reports `UNAVAILABLE` and sends nothing. With `--allow-mint` it mints pairs instead (1 USDC of collateral per claim), then sells the PIRY-S leg on the PIRY-S Kuru market if one is configured, or sends it to `--short-to`. If neither applies it reports `UNHEDGED_PAIR`: both legs are held and net exposure is flat. If the short sale fills only partly, the unsold PIRY-S still offsets the long, so the result is `PARTIAL` and lists where it sits.

## Safety model

What the plugin checks itself, before a step reaches the wallet or in its own reads:

- Preview first. `hedge` without `--max-premium` sends nothing.
- Spend cap. Each step's spend is checked against `--max-premium` first; a breach throws `CAP_EXCEEDED` with nothing sent for that step. The order size is also bounded by the cap when it is computed.
- Kuru minimum notional. An order below the market's minimum is refused (`BELOW_MIN_NOTIONAL`) instead of reverting.
- Stale-price preflight. Before any flow that needs a Kuru withdrawal, the plugin asks Kuru's withdrawal limiter whether the claim price is fresh (older than 1800 s reverts). This is a point-in-time check, not a guarantee that a withdrawal will still be possible after a human approval delay. `position` and `quote` flag a mark older than 1,500 s.
- Verified book. AccountCore must list the Kuru market as a verified spot order book, and its base token, quote token and active state must match PIRY-L or PIRY-S and Kuru test USDC, otherwise `KURU_MARKET_MISMATCH`. The Piry contracts are cross-checked against what the market contract reports (`SERIES_MISMATCH`), as is the chain id.
- Settled refusal. `hedge` is refused once the period has ended or the series is settled (`SERIES_CLOSED`); `redeem` is refused before settlement (`NOT_SETTLED`).
- Price floors. Buys and sales carry a minimum-out computed from the market's own `estimateSwap` and `--slippage` (default 100 bps, refused above 1000). `unwind --min-proceeds` is a total floor across merge and sale. `redeem` sets `--min-payout` to the contract's previewed payout by default and refuses to send if `previewRedeem` disagrees with the plugin's payout math.
- A step counts as completed only on a mined success: host status `CONFIRMED`, or a successful chain receipt when the host's status is missing or only says broadcast. A failed, reverted, or unconfirmed step stops the command with `FAILED` or `UNCERTAIN`, no dependent write is sent, every submitted hash is printed, and nothing is retried.
- Failures report where funds are, and a hedge reports requested versus used versus unspent quote and leftover balances with their location.
- No signing path. The plugin has no key, mnemonic or session access and imports no signing code. A test fails if any source file references a signing or broadcasting API, or if anything other than `src/base.ts` touches the executor.
- Least privilege. `quote` declares no capability and `position` only `wallet-read`; only `hedge`, `unwind` and `redeem` declare `wallet-submit`. The plugin-wide capability list is empty. Every command targets chain 10143 only.
- Reads use the public Monad RPC (`https://testnet-rpc.monad.xyz`, override with `PIRY_RPC_URL`, https or loopback only). Nothing is written to disk.

What belongs to the host, and what was observed (13 Oct 2026, `mm` 7.1.0, Monad testnet 10143):

- All writes are submitted through the Agent Wallet host (`ctx.walletExecutor`). The host signs; the plugin never does.
- Changing the Guard policy required email MFA. That is the one enforced Guard control we observed.
- Guard's allowlist and rolling outflow limit did not block transfers on chain 10143 in our test. With a policy that allowlisted only the Piry and Kuru addresses and set a $50 24-hour outflow limit, a transfer of 10 PIRY-L and a transfer of 0.01 MON to a non-allowlisted, team-owned address were both broadcast. This was one observation, not repeated and not explained; we do not know whether the cause is the chain, the host version or the policy. Do not rely on Guard for per-transaction allowlist or outflow enforcement on Monad testnet.
- `--max-premium` and the checks above bound what the `mm piry` commands do. They do not restrict other `mm` commands, transfers or MON gas, and they are not a wallet-wide loss limit.
- Whether the host's threat scan applied to these transactions was not observed.

## Install

Requires `mm` 6.2.0 or newer and Node 22.18+. Installed and run on `mm` 7.1.0; the manifest range `>=6.2.0 <8.0.0` is checked against 6.2.0, 6.2.1, 7.0.0 and 7.1.0 in the tests (the template's `^6.2.0` would be refused by 7.x). Plugins are a beta feature.

1. Make `mm` able to submit on chain 10143. On `mm` 7 the host's gateway answers `Invalid chainId` for Monad testnet, so every write fails at gas estimation until the chain is added. Reported workaround ([issue 6](https://github.com/MetaMask/agent-wallet-plugin-template/issues/6)), applied for the 13 Oct run: with no `mm` command running, add this to `~/.metamask/wallets.json` under `data.customEvmChains` (keep a backup):
   ```json
   { "key": "monad-testnet", "chainId": 10143, "caip2": "eip155:10143", "name": "Monad Testnet",
     "nativeCurrency": { "name": "Monad", "symbol": "MON", "decimals": 18 },
     "blockExplorer": "https://testnet.monadscan.com", "rpcTarget": "https://testnet-rpc.monad.xyz" }
   ```
   The plugin maps this failure to `MM_CHAIN_RPC_UNAVAILABLE` with the same hint. Reads (`quote`, `position`) do not need it.
2. Build and install the plugin:
   ```bash
   cd plugins/metamask-piry
   npm ci
   npm run build
   mm config set experimentalPlugins true
   mm config set experimentalAllowUnverifiedInstalls true      # local install only
   mm plugins install "file:$PWD" --accept-permissions         # review the consent screen instead if you prefer
   mm piry quote
   ```

Install from the directory, not a tarball. Installing from npm currently fails on some `mm` versions ([template issue 4](https://github.com/MetaMask/agent-wallet-plugin-template/issues/4)), so the demo uses `file:`. To publish, remove `"private": true` first. Give the agent the skill by copying `skills/piry/` into its skills directory. Rebuild after changing `src/`: `mm` runs `dist/`.

Configuration (all optional; the live Kuru markets are built in): `PIRY_KURU_MARKET` / `--kuru-market` overrides the PIRY-L/USDC order book (default `0xe2393d5f15523931e59f340cffebcde30fa7db1a`), `PIRY_KURU_SHORT_MARKET` / `--kuru-short-market` overrides PIRY-S/USDC (default `0xd93db02c88d645e669a3965cd46e72cca137f193`), `PIRY_RPC_URL` overrides the read RPC. An explicitly empty value disables that market.

## Real-wallet prerequisites

1. `mm login` then `mm init --wallet server-wallet --mode guard` (or `--wallet byok`). `mm doctor` must show `authenticated: true`, `initialized: true`.
2. Fund the wallet address (`mm wallet address`) on Monad testnet with MON for gas and Kuru test USDC (`0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1`) at least equal to the cap.
3. Add chain 10143 to `customEvmChains` (Install, step 1).
4. Guard policy (optional). Setting it requires email MFA. A sensible policy allows network 10143 and allowlists the addresses the hedge touches, with an outflow limit at or above the cap; see `mm wallet policy template` for the field names. Addresses: Piry market `0xe3Aab2F36601cEC8d217DA5497fC3FE00ed22538`, collateral `0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1`, PIRY-L `0x7D4B1319648B1f2478495Dcce10313Cd045Ef997`, PIRY-S `0xF3ACA854B4e0626CDedd391eC1396DBde6820d48`, Kuru AccountCore `0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038`, plus the two Kuru order books: PIRY-L/USDC `0xe2393d5f15523931e59f340cffebcde30fa7db1a` and PIRY-S/USDC `0xd93db02c88d645e669a3965cd46e72cca137f193`. On 13 Oct this policy did not stop transfers outside the allowlist on chain 10143 (Safety model), so treat it as configuration, not as a guarantee.

## Real run on the Agent Wallet (13 Oct 2026)

`mm piry hedge --gpu-hours 20 --max-premium 20` through a server-wallet in Guard mode (`0x8a9b8d5c25f182fda610e5fe8c7276ecd69e9d3a`) on `mm` 7.1.0, buying PIRY-L on the live Kuru book. 20 GPU-hours need 40 claims. The run bought 39 PIRY-L of 40 for 18.085 USDC (average 0.4637 USDC per claim) and ended `PARTIAL`: the cap and the book depth limited it. The wallet held 39 PIRY-L afterwards.

| Step | Transaction |
| --- | --- |
| approve | `0x5ab3a66a43531da5a8db3975cd5e09910f6449caff8c92f41552b6d17d6f77ed` |
| deposit | `0x1c62440f9e804e235b6c1a25469a2fcf18e7c3e855c7394acb5f717e1670d4d3` |
| swap | `0xbb5ab624180c2ba9d9f38634fde7974ce0cb029b10ac83fddf3095fdbda1aa71` |
| withdraw | `0x7c5c446428a6e59a9a285766463f3192ee755f44c7b54293fe823c98c2103728` |

What this shows: the buy path works end to end through the Agent Wallet on chain 10143 once `customEvmChains` is set. What it does not show: `unwind`, `redeem` and the mint fallback have not been submitted through a real wallet; Guard policy enforcement (above); or behavior on any other run, since it is one run. The step confirmation, balance reconciliation, total `--min-proceeds` floor and book-free `redeem` described here were written after that run and are covered by the simulator tests, not by a new real run.

## Demo script (about 5 minutes)

Setup before recording: the Install and prerequisite steps and the plugin installed. The Kuru markets are built in. This follows the flow actually observed on 13 Oct; do not script a larger hedge than the book can fill, and say `PARTIAL` plainly if that is what the run returns.

| Time | Say and show |
| --- | --- |
| 0:00 | "My agent rents H100s at about $3.41 an hour. If that rises, its bill rises." `mm plugins` and `mm piry --help`: the plugin is installed, and the consent screen listed which commands can submit. |
| 0:30 | `mm piry quote --gpu-hours 20 --sources`. The last on-chain mark, the band, 20 GPU-hours need 40 claims, and the payout scenarios to the $4.50 cap. The live-sources block is a labelled preview. Read what it shows (how many sources answered, and the index) rather than saying they agree. |
| 1:15 | `mm piry hedge --gpu-hours 20`. Preview only: spend, expected claims, the slippage floor, average price. Nothing sent. |
| 2:00 | `mm piry hedge --gpu-hours 20 --max-premium 20 --slippage 100`. Show the intents in the Agent Wallet, then the four steps (approve, deposit, swap, withdraw). On 13 Oct this returned `PARTIAL`: 39 of 40 claims for 18.085 USDC. Point at `reconciliation`: requested, used and unspent quote, net coverage, leftovers. `HEDGED` appears only if the book fills the whole request. |
| 3:00 | `mm piry position`: claims in the wallet and Kuru, value at the mark, covered GPU-hours; it agrees with the hedge result. After a `PARTIAL`, preview again with `mm piry hedge --gpu-hours 20`; do not re-run the executing command unreviewed. |
| 3:30 | The Guard moment, said accurately: changing the Guard policy needed email MFA. Do not say Guard blocked a transfer; in the 13 Oct test it did not on chain 10143. |
| 4:15 | `mm piry redeem` before settlement: refused with the countdown and the 7-day permissionless fallback. After settlement the same command redeems above the previewed floor, even if a Kuru book has changed. |
| 4:45 | Close: every write went through the Agent Wallet; the plugin cannot sign; the cap, the price floors and the step confirmation are enforced by the plugin before and between writes. |

## Develop

```bash
npm run typecheck      # src and tests
npm test               # 165 offline tests pass (4 live tests are skipped)
PIRY_LIVE=1 npm test   # also runs 4 read-only checks against Monad testnet; the wallet in them throws if anything tries to send
```

`test/sim.ts` is a small chain simulator: the mocked Agent Wallet decodes the exact calldata the plugin proposes (Piry market, ERC-20, Kuru AccountCore and order book) and applies it, so the flows are tested end to end without a network. It can script the host status and the chain receipt of any write, thin an order book between estimate and swap, and break the Kuru books or AccountCore. `test/parity.test.ts` feeds the same response bodies to this plugin's source rules and to the workflow's own code (`workflow/composite.ts`, `workflow/onchain.ts` and its fixtures) and requires the same verdict and price; it skips with a notice if `workflow/` is not next to the plugin.

Layout: `src/commands/piry/*` are thin oclif commands; `src/hedge.ts`, `unwind.ts`, `redeem.ts`, `position.ts`, `quote.ts` hold the flows; `reconcile.ts` reads balances back after a write; `kuru.ts` encodes Kuru V2 calls with `@toxicflow-labs/ts-sdk` request builders; `math.ts` mirrors `PayoutMath` floor semantics; `sources.ts` ports the composite index's four source rules (HTTP 200 only, byte caps of 65,536 and 200,000 for Verda, integer counts, cloud-name validation); `tx.ts` holds the budgeted, receipt-checked step runner.

## Limits

- Testnet only, test tokens, unaudited.
- The PIRY-L and PIRY-S Kuru markets exist and are the plugin defaults. The buy path of `hedge` has run once through a real Agent Wallet (above). `unwind`, `redeem` and the mint fallback are tested against a calldata-decoding simulator and have not.
- Guard allowlist and outflow limits did not block transfers on chain 10143 in our one test; do not rely on them (Safety model).
- Both books are seeded by the Piry team; liquidity is thin and not organic, so larger hedges end `PARTIAL`.
- The plugin has no command that withdraws idle USDC or PIRY-S from a Kuru trading balance. `hedge` reports what is left and the exact AccountCore `withdraw` call; the next `hedge` spends idle USDC first, and `redeem` withdraws Kuru-held claims after settlement. `unwind` does not merge PIRY-S held inside Kuru.
- `hedge` and `unwind` still verify the Kuru books before trading, so a broken book blocks them. `redeem` does not depend on a book.
- The stale-price preflight is a point in time. If the mark goes stale after you approve, a withdrawal can still revert (`PRICE_STALE`).
- Reconciliation reads balances from the public RPC right after the last confirmed step. If that RPC lags the host's, run `mm piry position` again.
