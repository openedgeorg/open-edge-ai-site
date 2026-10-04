# Qualification evidence

DA-01 is an adopted design assumption. It is not a passed gate.

`scripts/qualify.py` records capability inventory and gate decisions. Missing binaries, skipped tests, empty captures and unproven primitives stay `pending` and the process exits nonzero. A demonstrated essential absence is `invalidated` for that provider only. A G2 functional pass does not write `validated`.

`inspect`, `g1` and `g2` exit zero only when that functional gate is complete. `da01` exits zero only after a reviewed validation. Ordinary pytest success is neither result.

Candidate files in this directory are sanitized inventories. They are not production qualification rows. Synthetic fixtures are refused by `record_qualification` when `synthetic=True` or when the evidence reference uses the `synthetic:` scheme.

Gate 1 evidence is the local Compose stack (`infra/local/compose.yaml`) plus a real Codex session and a real Grok Build session whose model traffic is aimed only at the local ESP gateway. A kube context, cluster uid, namespace `esp-qualification`, node addresses and storage fencing are not G1 requirements. Brain presence and conversation isolation still are. A missing or refused live session stays `pending` (or `invalidated` when a bypass or isolation failure is observed). It is not a pass.

Grok 1.0.46 refuses `session/new` until an auth method is selected. The gate does not call ACP `authenticate` (that opens public HTTPS). It writes a non-secret `api_key` onto the staged loopback model so the build selects `xai.api_key`. That value is not the provider credential; the gateway still owns `ESP_PROVIDER_CREDENTIAL_REF`.

```bash
uv run --all-packages python scripts/qualify.py g1 --provider openai
uv run --all-packages python scripts/qualify.py g1 --provider xai
```

Network, storage and Gate 2 still use the disposable cluster record when those gates are run. That record is not read as G1 evidence.

Live commands:

```bash
uv run --all-packages python scripts/qualify.py inspect --provider openai
uv run --all-packages python scripts/qualify.py inspect --provider xai
```

Both are pending until real shared-process evidence exists. Do not treat this README as that evidence.
