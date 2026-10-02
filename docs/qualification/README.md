# Qualification evidence

DA-01 is an adopted design assumption. It is not a passed gate.

`scripts/qualify.py` records capability inventory and gate decisions. Missing binaries, skipped tests, empty captures and unproven primitives stay `pending` and the process exits nonzero. A demonstrated essential absence is `invalidated` for that provider only. A G2 functional pass does not write `validated`.

`inspect`, `g1` and `g2` exit zero only when that functional gate is complete. `da01` exits zero only after a reviewed validation. Ordinary pytest success is neither result.

Candidate files in this directory are sanitized inventories. They are not production qualification rows. Synthetic fixtures are refused by `record_qualification` when `synthetic=True` or when the evidence reference uses the `synthetic:` scheme.

Live commands:

```bash
uv run --all-packages python scripts/qualify.py inspect --provider openai
uv run --all-packages python scripts/qualify.py inspect --provider xai
```

Both are pending until real shared-process evidence exists. Do not treat this README as that evidence.
