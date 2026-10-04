"""Native isolation is not credited from a mapper. A leak invalidates; silence stays pending."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import Gate2Observation, evaluate_gate2, run_gate2


@pytest.mark.qualification
def test_unobserved_isolation_stays_pending_and_a_leak_invalidates() -> None:
    pending = run_gate2("xai", None)
    assert pending.status == "pending"
    assert pending.essential_absence is False
    leaked = Gate2Observation(cross_visitor_leaks=1, stale_mutations=1)
    decided = evaluate_gate2("xai", leaked)
    assert decided.status == "invalidated"
    assert decided.essential_absence is True
