.PHONY: verify check-deploy preflight settlement-proof workflow-build deploy-local deploy-testnet

verify: check-deploy
	python3 -m unittest discover -s tests -v
	forge test --offline
	npm run check:workflow
	npm run test:workflow

check-deploy:
	npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict scripts/deploy.ts

preflight:
	python3 scripts/preflight.py

settlement-proof:
	forge build --offline
	npm run proof:settlement

workflow-build:
	npm run build:workflow

deploy-local:
	forge build --offline
	bun scripts/deploy.ts --network local $(if $(SERIES),--series $(SERIES))

# Sends real transactions. Needs SERIES=<file>, CONFIRM=1 and DEPLOYER_PRIVATE_KEY in the environment
# (or ENV_FILE=<path> to have Bun load it); MONAD_TESTNET_RPC overrides the public RPC.
deploy-testnet:
	forge build --offline
	bun $(if $(ENV_FILE),--env-file=$(ENV_FILE)) scripts/deploy.ts --network monad-testnet $(if $(SERIES),--series $(SERIES)) $(if $(filter 1,$(CONFIRM)),--confirm)
