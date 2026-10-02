"""Operation scopes and revocation fences fail closed against the primary database."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from tests.support.authority import AuthorityLab, build_authority_lab

MISMATCHES = [
    "brain_hash",
    "behavior_hash",
    "behavior_version",
    "corpus",
    "deployment",
    "guard",
    "native_id",
    "epoch",
    "lease",
    "incarnation",
    "provider",
    "model",
    "run_id",
    "generation",
    "conversation",
    "signature",
]


@pytest.fixture
async def authority_lab() -> AsyncIterator[AuthorityLab]:
    lab = await build_authority_lab()
    try:
        yield lab
    finally:
        await lab.close()


async def test_scopes_and_revocations_fail_closed(authority_lab: AuthorityLab) -> None:
    assert await authority_lab.setup_token_inference_starts() == 0
    assert await authority_lab.swapped_audience_tool_calls() == 0
    assert await authority_lab.revoked_mapping_dispatch_starts() == 0
    assert await authority_lab.revoked_incarnation_dispatch_starts() == 0
    assert not await authority_lab.old_completion_clears_replacement()


@pytest.mark.parametrize("kind", MISMATCHES)
async def test_pin_guard_and_identity_mismatches_do_not_start(authority_lab: AuthorityLab, kind: str) -> None:
    assert await authority_lab.mismatch_starts(kind) == 0  # type: ignore[arg-type]


async def test_current_authority_starts_without_waiting_for_the_provider(authority_lab: AuthorityLab) -> None:
    starts, response_still_pending = await authority_lab.current_inference_starts()
    assert starts == 1
    assert response_still_pending


async def test_revoke_cannot_preempt_a_held_dispatch_fence(authority_lab: AuthorityLab) -> None:
    blocked, starts = await authority_lab.revoke_blocked_during_dispatch()
    assert blocked
    assert starts == 1


async def test_primary_outage_and_disablement_do_not_start(authority_lab: AuthorityLab) -> None:
    assert await authority_lab.profile_disabled_starts() == 0


async def test_release_withdrawal_blocks_new_dispatch(authority_lab: AuthorityLab) -> None:
    assert await authority_lab.release_disabled_starts() == 0


async def test_primary_outage_blocks_new_dispatch(authority_lab: AuthorityLab) -> None:
    assert await authority_lab.primary_outage_starts() == 0


async def test_native_registration_is_conditional(authority_lab: AuthorityLab) -> None:
    assert await authority_lab.conditional_native_registration()
