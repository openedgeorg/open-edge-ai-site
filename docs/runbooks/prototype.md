# Isolated prototype

Start the static development client with `uv run python scripts/dev.py`. It serves `site/` on `127.0.0.1:8765` and does not call a model.

Formal section 23 evaluation reads an explicit `--release` id. There is no latest-release fallback. Do not run it against a pending runtime and expect a pass. The command exits nonzero until approved content and both DA-01 decisions exist.

The marketing seed in `site/index.html` is not domain content. Synthetic cases in `tests/fixtures/evals/cases.json` are not an approved corpus.
