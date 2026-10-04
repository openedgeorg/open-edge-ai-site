# ESP v1 readiness

Status: blocked.

Both provider manifests remain `pending`. Gate 1, Gate 2, capacity, DA-01, section 23, G3, privacy, and the v1 release gate have no approved live evidence bundle in this tree. There is no `acceptance-budgets.json`. The evaluation fixture is synthetic and is not approved domain content. The Kubernetes base renders a packaging skeleton and is not a deployment.

`uv run --all-packages python scripts/qualify.py release --milestone v1` is expected to exit nonzero. A synthetic in-memory readiness fixture exercises the evaluator only and must not write a qualification row.

Do not treat this document as a production approval.
