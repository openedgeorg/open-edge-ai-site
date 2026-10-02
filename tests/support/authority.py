"""Two-connection authority lab. Tokens are checked against the live primary row."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, LiteralString, cast

from esp_contracts.runtime import AuthorityRecord, DispatchTicket, ProviderResponse, RunBinding
from esp_db.authority import read_current_authority
from esp_db.client import Db, open_db
from esp_execution_bindings.authorize import authorize_binding
from esp_execution_bindings.binding import (
    TokenSigner,
    TokenVerifier,
    mint_operation_authority,
    mint_setup_authority,
    verify_binding,
)
from esp_execution_bindings.dispatch_fence import (
    clear_terminal_guard,
    disable_profile,
    register_native_session,
    revoke_incarnation,
    revoke_mapping,
    with_dispatch_authority,
    withdraw_release,
)
from scripts.migrate import migrate
from tests.support.database import APP_DSN

HASH = "a" * 64
OTHER_HASH = "b" * 64
Mismatch = Literal[
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


@dataclass
class _Seed:
    conversation_id: uuid.UUID
    session_id: uuid.UUID
    instance_id: uuid.UUID
    incarnation_id: uuid.UUID
    run_id: uuid.UUID
    release_id: str
    qualification_id: str
    deployment_id: str


class _Ticket:
    def __init__(self) -> None:
        self.inference_id = "inference-test"
        self.initiation: Mapping[str, str] = {"boundary": "test-transport"}
        self.write_completed = True
        self.response: Awaitable[ProviderResponse] = cast(
            Awaitable[ProviderResponse], asyncio.get_running_loop().create_future()
        )


class AuthorityLab:
    def __init__(self, db: Db, signer: TokenSigner, verifier: TokenVerifier, seed: _Seed) -> None:
        self.db = db
        self.signer = signer
        self.verifier = verifier
        self.seed = seed
        self.starts = 0

    async def close(self) -> None:
        try:
            await self.db.close()
        except Exception:
            return

    async def setup_token_inference_starts(self) -> int:
        record = await self._record()
        token = mint_setup_authority(record, signer=self.signer)
        return await self._starts_from_token(token, "inference")

    async def swapped_audience_tool_calls(self) -> int:
        inference, knowledge = await self._operation_tokens()
        tool_starts = await self._starts_from_token(inference, "knowledge")
        inference_starts = await self._starts_from_token(knowledge, "inference")
        return tool_starts + inference_starts

    async def revoked_mapping_dispatch_starts(self) -> int:
        binding = await self._binding("inference")
        revoked = await revoke_mapping(self.db, str(self.seed.session_id), 1)
        if not revoked:
            return 1
        return await self._dispatch(binding)

    async def revoked_incarnation_dispatch_starts(self) -> int:
        peer = await self._insert_without_native()
        await self._execute(
            """
            UPDATE provider_session
            SET native_session_id = 'native-peer', runtime_state = 'running',
                owner_lease_expires_at = now() + interval '15 minutes',
                active_agent_run_id = %s, active_agent_run_expires_at = now() + interval '15 minutes'
            WHERE id = %s
            """,
            (uuid.uuid4(), peer),
        )
        await self._execute(
            """
            UPDATE conversation AS c
            SET active_provider_session_id = ps.id
            FROM provider_session AS ps
            WHERE ps.id = %s AND c.id = ps.conversation_id
            """,
            (peer,),
        )
        revoked = await revoke_incarnation(self.db, str(self.seed.instance_id), str(self.seed.incarnation_id))
        if str(self.seed.session_id) not in revoked or str(peer) not in revoked:
            return 1
        try:
            binding = await self._binding("inference")
        except Exception:
            return 0
        return await self._dispatch(binding)

    async def old_completion_clears_replacement(self) -> bool:
        replacement = uuid.uuid4()
        async with self.db.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s",
                    (self.seed.conversation_id,),
                )
                await connection.execute(
                    "UPDATE provider_session SET is_current = false WHERE id = %s",
                    (self.seed.session_id,),
                )
                await connection.execute(
                    """
                    INSERT INTO provider_session (
                        id, conversation_id, provider, session_generation, is_current, native_session_id, model,
                        brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                        deployment_ref, runtime_state, harness_instance_id, runtime_incarnation_id,
                        native_storage_unit_id, state_location, ownership_epoch, owner_lease_expires_at,
                        active_agent_run_id, active_agent_run_expires_at, recovery_count, created_at, last_used_at
                    )
                    SELECT %s, conversation_id, provider, session_generation + 1, true, native_session_id, model,
                        brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                        deployment_ref, 'running', harness_instance_id, runtime_incarnation_id,
                        native_storage_unit_id, state_location, ownership_epoch, owner_lease_expires_at,
                        %s, active_agent_run_expires_at, recovery_count, created_at, last_used_at
                    FROM provider_session WHERE id = %s
                    """,
                    (replacement, uuid.uuid4(), self.seed.session_id),
                )
                await connection.execute(
                    "UPDATE conversation SET active_provider_session_id = %s WHERE id = %s",
                    (replacement, self.seed.conversation_id),
                )
        cleared = await clear_terminal_guard(self.db, str(self.seed.session_id), 1)
        async with self.db.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT active_provider_session_id FROM conversation WHERE id = %s",
                (self.seed.conversation_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            raise AssertionError("conversation missing")
        return cleared or row["active_provider_session_id"] != replacement

    async def current_inference_starts(self) -> tuple[int, bool]:
        self.starts = 0

        async def start() -> DispatchTicket:
            self.starts += 1
            return _Ticket()

        binding = await self._binding("inference")
        ticket = await asyncio.wait_for(
            with_dispatch_authority(binding, start, db=self.db),
            timeout=2,
        )
        pending = not asyncio.isfuture(ticket.response) or not ticket.response.done()
        return self.starts, pending and ticket.write_completed

    async def revoke_blocked_during_dispatch(self) -> tuple[bool, int]:
        observed: list[bool] = []
        started = 0

        async def start() -> DispatchTicket:
            nonlocal started
            started += 1
            observed.append(await revoke_mapping(self.db, str(self.seed.session_id), 1))
            return _Ticket()

        binding = await self._binding("inference")
        await with_dispatch_authority(binding, start, db=self.db)
        return observed == [False], started

    async def mismatch_starts(self, kind: Mismatch) -> int:
        binding = await self._binding("inference")
        if kind == "lease":
            await self._execute(
                "UPDATE provider_session SET owner_lease_expires_at = now() - interval '1 minute' WHERE id = %s",
                (self.seed.session_id,),
            )
        elif kind == "guard":
            await self._execute(
                "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s",
                (self.seed.conversation_id,),
            )
        elif kind == "incarnation":
            await self._execute(
                "UPDATE provider_session SET runtime_incarnation_id = %s WHERE id = %s",
                (uuid.uuid4(), self.seed.session_id),
            )
        elif kind == "epoch":
            await self._execute(
                "UPDATE provider_session SET ownership_epoch = ownership_epoch + 1 WHERE id = %s",
                (self.seed.session_id,),
            )
        if kind == "brain_hash":
            binding = binding.model_copy(update={"brain_hash": OTHER_HASH})
        elif kind == "behavior_hash":
            binding = binding.model_copy(update={"behavior_hash": OTHER_HASH})
        elif kind == "behavior_version":
            binding = binding.model_copy(update={"behavior_version": "other-behavior"})
        elif kind == "corpus":
            binding = binding.model_copy(update={"corpus_release_id": "other-corpus"})
        elif kind == "deployment":
            binding = binding.model_copy(update={"deployment_ref": "other-deployment"})
        elif kind == "native_id":
            binding = binding.model_copy(update={"native_session_id": "other-native"})
        elif kind == "provider":
            binding = binding.model_copy(update={"provider": "xai"})
        elif kind == "model":
            binding = binding.model_copy(update={"model": "other-model"})
        elif kind == "run_id":
            binding = binding.model_copy(update={"active_agent_run_id": str(uuid.uuid4())})
        elif kind == "generation":
            binding = binding.model_copy(update={"session_generation": binding.session_generation + 1})
        elif kind == "conversation":
            binding = binding.model_copy(update={"conversation_id": str(uuid.uuid4())})
        elif kind == "signature":
            _inference, _knowledge = await self._operation_tokens()
            return await self._starts_from_token(_inference[:-4] + "aaaa", "inference")
        return await self._dispatch(binding)

    async def primary_outage_starts(self) -> int:
        await self.db.close()
        try:
            return await self._authorized_starts()
        except Exception:
            return self.starts

    async def release_disabled_starts(self) -> int:
        changed = await withdraw_release(self.db, self.seed.release_id)
        if not changed:
            raise AssertionError("release withdrawal did not take the fence")
        return await self._authorized_starts()

    async def profile_disabled_starts(self) -> int:
        binding = await self._binding("inference")
        disabled = await disable_profile(self.db, self.seed.qualification_id)
        if not disabled:
            return 1
        return await self._dispatch(binding)

    async def conditional_native_registration(self) -> bool:
        bare = await self._insert_without_native()
        wrong_epoch = await register_native_session(self.db, str(bare), 99, "native-b")
        registered = await register_native_session(self.db, str(bare), 1, "native-b")
        replaced = await register_native_session(self.db, str(bare), 1, "native-c")
        async with self.db.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT native_session_id FROM provider_session WHERE id = %s",
                (bare,),
            )
            row = await cursor.fetchone()
        if row is None:
            raise AssertionError("bare session missing")
        return (not wrong_epoch) and registered and (not replaced) and row["native_session_id"] == "native-b"

    async def _authorized_starts(self) -> int:
        try:
            binding = await self._binding("inference")
        except Exception:
            return self.starts
        return await self._dispatch(binding)

    async def _starts_from_token(self, token: str, audience: Literal["inference", "knowledge"]) -> int:
        self.starts = 0
        try:
            binding = verify_binding(token, audience, verifier=self.verifier)
        except Exception:
            return 0
        return await self._dispatch(binding)

    async def _dispatch(self, binding: RunBinding) -> int:
        self.starts = 0
        try:
            await authorize_binding(binding, db=self.db)
        except Exception:
            return 0

        async def start() -> DispatchTicket:
            self.starts += 1
            return _Ticket()

        try:
            await with_dispatch_authority(binding, start, db=self.db)
        except Exception:
            return self.starts
        return self.starts

    async def _operation_tokens(self) -> tuple[str, str]:
        record = await self._record()
        authority = mint_operation_authority(record, signer=self.signer)
        return authority.inference_token, authority.knowledge_token

    async def _binding(self, audience: Literal["inference", "knowledge"]) -> RunBinding:
        inference, knowledge = await self._operation_tokens()
        token = inference if audience == "inference" else knowledge
        return verify_binding(token, audience, verifier=self.verifier)

    async def _record(self) -> AuthorityRecord:
        record = await read_current_authority(self.db, str(self.seed.session_id))
        if record is None:
            raise AssertionError("current authority missing")
        return record

    async def _execute(self, query: str, params: tuple[object, ...]) -> None:
        async with self.db.pool.connection() as connection:
            await connection.execute(cast(LiteralString, query), params)

    async def _insert_without_native(self) -> uuid.UUID:
        conversation_id = uuid.uuid4()
        session_id = uuid.uuid4()
        now = datetime.now(UTC)
        async with self.db.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO conversation (
                        id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                        corpus_release_id, status, created_at, updated_at
                    ) VALUES (%s, 'subject-a', 'openai', %s, 'behavior-a', %s, 'fixture-corpus', 'active', %s, %s)
                    """,
                    (conversation_id, self.seed.release_id, HASH, now, now),
                )
                await connection.execute(
                    """
                    INSERT INTO provider_session (
                        id, conversation_id, provider, session_generation, is_current, model,
                        brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                        deployment_ref, runtime_state, harness_instance_id, runtime_incarnation_id,
                        native_storage_unit_id, state_location, ownership_epoch, recovery_count,
                        created_at, last_used_at
                    ) VALUES (
                        %s, %s, 'openai', 1, true, 'candidate-model', %s, %s, 'behavior-a', %s,
                        'fixture-corpus', %s, 'starting', %s, %s, 'volume-a', 'location-a', 1, 0, %s, %s
                    )
                    """,
                    (
                        session_id,
                        conversation_id,
                        self.seed.release_id,
                        HASH,
                        HASH,
                        self.seed.deployment_id,
                        self.seed.instance_id,
                        self.seed.incarnation_id,
                        now,
                        now,
                    ),
                )
        return session_id


async def build_authority_lab() -> AuthorityLab:
    await migrate(APP_DSN)
    db = await open_db(APP_DSN)
    signer, verifier = TokenSigner.generate()
    seed = _Seed(
        conversation_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        instance_id=uuid.uuid4(),
        incarnation_id=uuid.uuid4(),
        run_id=uuid.uuid4(),
        release_id=f"brain-{uuid.uuid4()}",
        qualification_id=f"qual-{uuid.uuid4()}",
        deployment_id=f"deploy-{uuid.uuid4()}",
    )
    lease = datetime.now(UTC) + timedelta(minutes=15)
    now = datetime.now(UTC)
    async with db.pool.connection() as connection:
        async with connection.transaction():
            await connection.execute(
                """
                INSERT INTO brain_release (
                    version, sha256, behavior_version, behavior_sha256, source_revision,
                    artifact_ref, behavior_artifact_ref, corpus_release_id, status, created_at
                ) VALUES (%s, %s, 'behavior-a', %s, 'synthetic-canary', 'draft://brain', 'draft://behavior',
                    'fixture-corpus', 'draft', %s)
                """,
                (seed.release_id, HASH, HASH, now),
            )
            await connection.execute(
                """
                INSERT INTO runtime_qualification (id, design_assumption_id, provider, status)
                VALUES (%s, 'DA-01', 'openai', 'pending')
                """,
                (seed.qualification_id,),
            )
            await connection.execute(
                """
                INSERT INTO provider_deployment (
                    id, provider, model, harness_revision, configuration_digest, gateway_route,
                    shared_process_qualification_id, deployed_at
                ) VALUES (%s, 'openai', 'candidate-model', 'rev-test', 'cfg-test', 'gateway-test', %s, %s)
                """,
                (seed.deployment_id, seed.qualification_id, now),
            )
            await connection.execute(
                """
                INSERT INTO harness_instance (
                    id, provider, worker_id, process_incarnation_id, deployment_ref, native_storage_unit_id,
                    lifecycle_status, resident_session_limit, active_turn_limit, last_heartbeat_at
                ) VALUES (%s, 'openai', 'worker-a', %s, %s, 'volume-a', 'ready', 2, 2, %s)
                """,
                (seed.instance_id, seed.incarnation_id, seed.deployment_id, now),
            )
            await connection.execute(
                """
                INSERT INTO conversation (
                    id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                    corpus_release_id, status, created_at, updated_at
                ) VALUES (%s, 'subject-a', 'openai', %s, 'behavior-a', %s, 'fixture-corpus', 'active', %s, %s)
                """,
                (seed.conversation_id, seed.release_id, HASH, now, now),
            )
            await connection.execute(
                """
                INSERT INTO provider_session (
                    id, conversation_id, provider, session_generation, is_current, native_session_id, model,
                    brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                    deployment_ref, runtime_state, harness_instance_id, runtime_incarnation_id,
                    native_storage_unit_id, state_location, ownership_epoch, owner_lease_expires_at,
                    active_agent_run_id, active_agent_run_expires_at, recovery_count, created_at, last_used_at
                ) VALUES (
                    %s, %s, 'openai', 1, true, 'native-a', 'candidate-model', %s, %s, 'behavior-a', %s,
                    'fixture-corpus', %s, 'running', %s, %s, 'volume-a', 'location-a', 1, %s, %s, %s, 0, %s, %s
                )
                """,
                (
                    seed.session_id,
                    seed.conversation_id,
                    seed.release_id,
                    HASH,
                    HASH,
                    seed.deployment_id,
                    seed.instance_id,
                    seed.incarnation_id,
                    lease,
                    seed.run_id,
                    lease,
                    now,
                    now,
                ),
            )
            await connection.execute(
                "UPDATE conversation SET active_provider_session_id = %s WHERE id = %s",
                (seed.session_id, seed.conversation_id),
            )
    return AuthorityLab(db, signer, verifier, seed)
