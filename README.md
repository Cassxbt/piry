# Piry

Piry helps developers and businesses manage GPU rental-price risk through capped, tradable contracts on Monad.

The local contract prototype turns collateral into paired long and short ERC-20 claims. After settlement, the claims have complementary payouts within a fixed price range. It does not reserve compute capacity or guarantee reimbursement of a GPU bill.

## Run locally

Requires Python 3.10+, Node.js/npm, Make and Foundry with Solidity 0.8.31/Osaka support. Verified locally with Foundry 1.5.1. OpenZeppelin Contracts is pinned to 5.4.0.

```sh
npm ci --ignore-scripts
forge build
make verify
```

`forge build` obtains the pinned compiler on the first run. `make verify` runs Python tests and Solidity unit/fuzz tests offline; no wallet, credentials or funds are needed.

Current verification: **50 Solidity tests and 9 Python tests pass**, including five fuzz properties run with 512 cases each. Attack tests cover reentrant collateral callbacks, false-return transfers, sender surcharges and rollback of balances and claim burns.

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

## Trust and limitations

- **Settlement authority:** the contract authenticates one configured address. The current tests use a local test authority. No CRE receiver, workflow or external data verification is implemented yet.
- **Data validity:** publication-time checks, period binding and an evidence hash do not prove price accuracy, complete observations or source freshness. The future workflow must verify these against the committed index specification. `publishedAt` means report publication time, not source observation time.
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
| CRE receiver and workflow | Not implemented |
| Licensed production index | Not established |
| Monad contract deployment and product UI | Not implemented |

## Read-only Kuru preflight

```sh
make preflight
```

This reads public Monad testnet state at a pinned finalized block and writes an ignored local report to `evidence/kuru-preflight.json`. An RPC error exits nonzero without refreshing that file; check its timestamp before using an existing report.

The checker verifies code, EIP1967 implementation pointers, existing-market registration, custody address, quote-token whitelist status and decimals. It separately checks the bounty faucet token and confirms the snapshot hash remains unchanged.

A passing baseline does not prove custom-token admission, market creation permission, an executed trade, withdrawal capacity or sponsor eligibility. The manifest records its documentation sources; the final Kuru deployment version remains unconfirmed.

## Development

Changes are committed as reviewed, coherent milestones. Research, planning, local instructions, credentials and generated evidence are excluded through an explicit file allowlist. New source files must be deliberately added before staging. AI tools assist implementation and testing under human review.

License: MIT. OpenZeppelin dependencies retain their own MIT license.
