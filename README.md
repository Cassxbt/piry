# Piry

Piry helps developers and businesses manage GPU rental-price risk through capped, tradable contracts on Monad.

## Current implementation

This repository contains a read-only Kuru testnet deployment checker and its offline tests. Settlement contracts, custom-market trading and the application interface are not yet implemented.

## Run

Requires Python 3.10+ and Make. No dependencies, wallet or signing keys are needed.

```sh
make verify
make preflight
```

`make verify` runs deterministic offline tests. `make preflight` reads public Monad testnet state at a pinned finalized block and writes a local report to `evidence/kuru-preflight.json`. Generated evidence is excluded from Git. A failed RPC request exits nonzero without refreshing the report; check its timestamp before using an existing report.

The checker verifies deployed code, EIP1967 implementation pointers, existing-market registration, custody address, quote-token whitelist status and decimals. It separately checks the bounty faucet token and confirms the snapshot hash remains unchanged.

Passing these checks establishes an existing-market baseline only. It does not prove custom-token admission, market creation permission, an executed trade, withdrawal capacity or sponsor eligibility. The manifest records its official documentation sources; the final product deployment version remains to be selected.

## Development

Changes are committed as reviewed, coherent milestones. Research, planning, local instructions, credentials and generated evidence are excluded through an explicit file allowlist. New source files must be deliberately added to that allowlist before staging.

AI tools assist implementation and testing under human review.
