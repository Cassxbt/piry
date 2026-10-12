# Piry

Piry helps developers and businesses manage GPU rental-price risk through capped, tradable contracts on Monad.

The local contract prototype turns collateral into paired long and short ERC-20 claims. After settlement, the claims have complementary payouts within a fixed price range. It does not reserve compute capacity or guarantee reimbursement of a GPU bill.

## Run locally

Requires Python 3.10+, Node.js 22/npm, Bun, Make and Foundry with Solidity 0.8.31/Osaka support. Verified with Bun 1.3.10 and Foundry 1.5.1. CRE CLI 1.33.0 is additionally required for the workflow build command. Dependencies are pinned in the npm lockfile.

```sh
npm ci --ignore-scripts
forge build
make verify
```

`forge build` obtains the pinned compiler on the first run. `make verify` runs Python, Solidity, data-validation and mocked CRE SDK tests offline; no wallet, credentials or funds are needed.

Current verification: **66 Solidity, 9 Python and 63 workflow tests pass**, including six fuzz properties run with 512 cases each. Attack tests cover reentrant collateral callbacks, false-return transfers, sender surcharges and rollback of balances and claim burns.

The compiler targets Osaka following [Monad’s compiler guidance](https://docs.monad.xyz/tooling-and-infra/toolkits/hardhat). Local EVM tests do not establish Monad-specific gas or execution parity. [Monad’s Foundry guide](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry) specifies Foundry 1.8+ and `network = "monad"` for that separate verification step.

## Contract lifecycle

1. **Mint:** before expiry, deposit collateral to receive equal quantities of long and short claims. Each claim uses the collateral token’s decimals; one pair of base units requires one collateral base unit.
2. **Transfer:** each claim is an ordinary transferable ERC-20. Only its market can mint or burn it. Actual exchange integration remains pending.
3. **Merge:** return equal quantities of both claims to recover the same collateral quantity, before or after expiry or settlement.
4. **Settle:** after expiry, the immutable settlement authority submits one report bound to the chain, market, index, specification hash, price decimals and exact period. Reports with invalid publication times or empty evidence hashes are rejected. Settlement cannot be revised.
5. **Redeem:** burn claims held by the caller and receive their fixed payout. Preview the amount and specify a minimum payout to protect against rounding loss.

For lower bound `L`, upper bound `U`, settlement price `P` and claim quantity `q`:

```text
long payout  = floor(q × clamp(P − L, 0, U − L) / (U − L))
short payout = floor(q × clamp(U − P, 0, U − L) / (U − L))
```

Illustration: 1,000 collateral units mint 1,000 of each claim. With bounds $2–$4 per GPU-hour and a settlement price of $3.50, the long claims redeem for 750 collateral units and the short claims for 250. This is payout arithmetic, not a quoted premium or a validated customer hedge.

## CRE settlement receiver

Deploy `SettlementReceiver(forwarder, workflowId)` first, then use its address as the market's `settlementAuthority`. One receiver may serve multiple series; each signed report explicitly identifies its destination market and chain. There are no administrative setters. Changing the authorized workflow requires a new receiver and market series.

The workflow ID depends on its final binary, configuration and owner. When configuration includes receiver/market addresses, predict their CREATE addresses from the controlled deployment nonce sequence before computing the final workflow ID. Verify the deployed addresses and registered ID before activation. Do not deploy with a placeholder ID or update a pinned workflow while its series remain unsettled. See the [CRE workflow hash command](https://docs.chain.link/cre/reference/cli/workflow#cre-workflow-hash).

The receiver implements ERC165 and `onReport(bytes,bytes)`. It checks the caller, requires the production 64-byte metadata layout and verifies the workflow ID before decoding the 320-byte `ComputeMarket.Report` payload. The market then enforces its committed series fields, time bounds and one-time settlement. Failed validation reverts without consuming settlement.

[Chainlink's consumer contract guide](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts) documents the metadata layout and simulation limitation. Its simulation forwarder omits workflow identity metadata, so this strict receiver intentionally rejects that route. A successful CLI dry run or outer transaction alone must not be reported as authenticated settlement: verify the intended market's `Settled` event and stored price/evidence hash. Production forwarder identity and deployment code must be checked for the selected network before deployment.

## Trust and limitations

- **Settlement authority:** configure the market with `SettlementReceiver` as its immutable authority. The receiver trusts one immutable forwarder and exact nonzero workflow ID. Its tests use a local transport fixture without DON signatures. No live CRE delivery is established.
- **Data validity:** the workflow checks declared source identity, units, hardware, complete slot coverage and observation/publication timestamps. These checks cannot establish that a source tells the truth. The demonstration has one synthetic source, with no supplier signature or licensed production feed. The workflow passes the dataset publication time into the report; observation timestamps remain in the hashed evidence.
- **Oracle liveness:** there is no timeout price, cancellation payout or administrative override. Without settlement, unmatched claims remain locked. Matched pairs can still be merged.
- **Rounding:** each leg rounds down independently. Small fragmented redemptions can forfeit more than one base unit in total. A zero minimum explicitly permits a zero-output burn; clients should preview and set a suitable minimum. Merging matched pairs avoids redemption dust.
- **Collateral:** only vetted, exact-transfer, non-rebasing ERC-20 assets are supported. Balance-delta checks reject fee-bearing receipts/payments but cannot prove that a token will never rebase, pause, blacklist users or change behavior.
- **Residuals:** dust and direct donations stay in the contract. There is no privileged withdrawal or sweep function.
- **Maturity:** local prototype, not audited or approved for real funds. No claim of liquidity, customer traction or guaranteed cost protection.

## What is implemented

| Component | Status |
|---|---|
| Capped payout math | Implemented with deterministic and fuzz tests |
| Collateral vault and paired ERC-20 claims | Implemented locally |
| Mint, transfer, merge, settle and redeem | Tested locally with synthetic prices and test collateral |
| Settlement refusal cases | Tested locally; not live CRE authentication |
| Kuru deployment preflight | Read-only existing-market checks |
| Custom Kuru market, fill and withdrawal | Not demonstrated |
| CRE receiver | Implemented and tested locally; no live authenticated delivery |
| CRE data workflow | Compiles to WASM; validator, SDK handler and local-chain proof pass |
| CRE CLI simulation / tenant network verification | Blocked by existing CLI credential refresh returning HTTP 403 |
| Licensed production index | Not established |
| Monad contract deployment and product UI | Not implemented |

## Data-validation workflow

The cron handler fetches a JSON dataset through CRE's HTTP capability. Each node validates it before identical-result consensus; only canonical validated evidence proceeds to `runtime.report` and `EVMClient.writeReport`. Authenticated mode requires an explicit successful receiver status. Missing status in simulation is reported as unverified.

The demonstration index is deliberately narrow: one declared hardware/region/source combination, USD per GPU-hour, integer prices at a committed decimal scale, and an equal-weight mean across 1–168 complete time slots, rounded down. Missing, duplicate, extra, off-grid or out-of-period observations are rejected. Floating-point prices, changed units/hardware, unsafe integers, stale/future publication, failed HTTP responses and oversized responses are rejected before a chain write.

`workflow/demo.ts` contains synthetic A100 observations of $2, $3 and $2. Their mean is $2.333333 at six decimals. The evidence hash commits to the canonical observations and specification. Freshness policy is bound by workflow configuration and the market's `maxReportAge`; it is not part of the reusable index specification hash. Keep those policies consistent when deploying a series.

```sh
make workflow-build
make settlement-proof
```

The first command compiles the actual CRE entrypoint to ignored `workflow/binary.wasm`. The second starts a temporary loopback-only Anvil node and proves validated data → ABI report → receiver → settlement event/state → redemption. It also checks duplicate data, a wrong-chain report, misleading outer-call success and replay. Its output explicitly states **synthetic data, local chain, mock transport, no DON signature proof**. Test accounts hold no public-network funds.

For CRE CLI simulation, copy `workflow/config.example.json` to ignored `workflow/config.demo.json`, replace both address placeholders, and configure the actual source endpoint and series terms. The example deliberately fails validation until addresses are supplied. Its static historical period is for fixture replay; it is not fresh live input. For a new series, configure its future period before market deployment, collect every observation during that period, and publish after it ends. Do not reset timestamps on old observations to bypass freshness checks.

After resolving CRE authentication, from `workflow/`:

```sh
cre workflow supported-chains --non-interactive
cre workflow simulate . -R . -T demo-settings --non-interactive --trigger-index 0
```

No broadcast flag is included. CLI simulation has not run: the tenant-network check returned HTTP 403 during credential refresh. Strict production receiver authentication remains enabled and is incompatible with the documented metadata-less simulation forwarder. Official signed-forwarder compatibility and authenticated Monad delivery are separate outstanding integration checks. No public deployment or sponsor eligibility is claimed.

## Read-only Kuru preflight

```sh
make preflight
```

This reads public Monad testnet state at a pinned finalized block and writes an ignored local report to `evidence/kuru-preflight.json`. An RPC error exits nonzero without refreshing that file; check its timestamp before using an existing report.

The checker verifies code, EIP1967 implementation pointers, existing-market registration, custody address, quote-token whitelist status and decimals. It separately checks the bounty faucet token and confirms the snapshot hash remains unchanged.

A passing baseline does not prove custom-token admission, market creation permission, an executed trade, withdrawal capacity or sponsor eligibility. The manifest records its documentation sources; the final Kuru deployment version remains unconfirmed.

## Development

Changes are committed as reviewed, coherent milestones. Research, planning, local instructions, credentials and generated evidence are excluded through an explicit file allowlist. New source files must be deliberately added before staging. AI tools assist implementation and testing under human review.

Piry source license: MIT. Dependencies retain their own licenses, including OpenZeppelin (MIT) and CRE SDK 1.23.0 (BUSL-1.1); the project license does not relicense dependencies.
