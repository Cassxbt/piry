.PHONY: verify preflight settlement-proof workflow-build

verify:
	python3 -m unittest discover -s tests -v
	forge test --offline
	npm run check:workflow
	npm run test:workflow

preflight:
	python3 scripts/preflight.py

settlement-proof:
	forge build --offline
	npm run proof:settlement

workflow-build:
	npm run build:workflow
