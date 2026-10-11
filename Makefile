.PHONY: verify preflight

verify:
	python3 -m unittest discover -s tests -v

preflight:
	python3 scripts/preflight.py
