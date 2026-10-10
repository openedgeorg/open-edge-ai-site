# Brain

The content owner supplies the conceptual Brain. This directory does not contain an approved domain artifact. The architecture PRD, the marketing seed, and synthetic evaluation cases are not a Brain release.

`local-draft-v3/` (release id `local-draft-brain-v3`) is the initial local brain the local compose listener publishes. Its essential content is the verbatim notes file at `/home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md`, as edited on 2026-10-09. It is not a company-approved canonical brain.

The v3 brain embeds the 50,394-byte revision of the notes saved on 2026-10-09 at 23:23 (sha256 `61f8361d77db0657cdbb29132a5ebe6930d663d07ce01bc6157fda6ef1660c88`). The notes file is still being edited. `tests/unit/test_local_draft_brain.py` fails when the file no longer matches (set `ESP_ALLOW_NOTES_DRIFT=1` to skip that one check), and the site's Atlas graph (`site/js/atlas-graph.js`, anchors in `tests/fixtures/atlas-trace.json`) is grounded in the same revision. Republish the brain and re-ground the graph when the notes change.

`local-draft-v2/` (`local-draft-brain-v2`) is the previous draft, built from an older revision of the same notes file. It is not the injection path.

`local-draft-v1/` (`local-draft-brain-v1`) is the oldest draft and is not the injection path.
