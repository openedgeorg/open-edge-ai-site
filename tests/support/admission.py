"""Admission and rate-counter labs over real PostgreSQL and real Valkey.

`AdmissionLab` runs several independent backends. Each backend has its own `esp_app` connection pool,
its own conversation service and its own Valkey client, so a race between backends is a race between
separate database sessions, never a sequence of mocks. Lock holders are further dedicated `esp_app`
connections that keep a transaction open while an admission runs.

Every runtime, release and policy value is a synthetic test identity inherited from `ApiLab`: pending
qualification rows and a recorded test-only candidate policy bound to an isolated deployment. Nothing
here inserts or upgrades a validated record.

The lab owns, for its lifetime, the provider-scope capacity slots of both providers. It snapshots them,
replaces them with its own budget and restores the snapshot when it closes, as `ApiLab` does for
`provider_capacity`. Instances it adds use the lab's own deployment reference, so no other test can
place work on them.

`native_submissions` stands in for the native submission that Task 16 performs after admission. It is
incremented only for an `Admitted` result, so it counts exactly the inputs that could have reached a
harness.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import time
import uuid
from collections import Counter
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, LiteralString, cast

from psycopg import AsyncConnection
from psycopg.rows import TupleRow, dict_row
from psycopg_pool import AsyncConnectionPool
from redis.asyncio import Redis

from esp_contracts.ids import Provider
from esp_db.client import Db, Transaction, open_db
from esp_espcon.conversation import ConversationService
from esp_execution_bindings.dispatch_fence import register_native_session
from esp_request_admission.admit import AdmissionController, AdmissionResult, Admitted, Rejected
from esp_request_admission.rate_limits import (
    RatePolicy,
    ValkeyRateLimiter,
    connect_rate_limiter,
    open_counter_client,
)
from esp_runtime_placement.capacity import SlotScope, provision_instance_slots, provision_provider_slots
from tests.support.api_lab import APP_ROLE_DSN, ApiLab, close_api_lab, open_api_lab

VALKEY_URL = os.environ.get("ESP_VALKEY_URL", "redis://127.0.0.1:63799/0")
UNREACHABLE_VALKEY_URL = "redis://127.0.0.1:1/0"
UNREACHABLE_DSN = "postgresql://esp_app:esp_app@127.0.0.1:1/esp"
PROVIDER: Provider = "openai"
PROVIDERS: tuple[Provider, ...] = ("openai", "xai")

# Generous enough that only the rate tests ever reach it.
LAB_RATE_POLICY = RatePolicy(
    policy_id="test-admission-lab",
    window_seconds=60,
    capacity=10_000,
    refill=10_000,
    expiry_seconds=60,
)


@dataclass(frozen=True)
class Conv:
    subject_id: str
    conversation_id: str


@dataclass
class Backend:
    """One Application Backend instance: its own pool, conversation service and counter client."""

    db: Db
    service: ConversationService
    limiter: ValkeyRateLimiter
    controller: AdmissionController


@dataclass
class LockHolder:
    """Another backend's open transaction. `release` rolls it back and closes the connection."""

    connection: AsyncConnection[TupleRow]
    locked_rows: int = 0
    released: bool = False

    async def release(self) -> None:
        if self.released:
            return
        self.released = True
        try:
            await self.connection.rollback()
        finally:
            await self.connection.close()


@dataclass
class SlotRow:
    scope: str
    scope_id: str
    slot_number: int
    holder: str | None
    epoch: int | None


@dataclass
class AdmissionLab:
    api: ApiLab
    admin: Db
    scope_key: bytes
    backends: list[Backend] = field(default_factory=lambda: [])
    instances: list[str] = field(default_factory=lambda: [])
    pool: list[str] = field(default_factory=lambda: [])
    native_submissions: Counter[str] = field(default_factory=lambda: Counter[str]())
    latencies: list[float] = field(default_factory=lambda: [])
    counter_keys: set[str] = field(default_factory=lambda: set[str]())
    _holders: list[LockHolder] = field(default_factory=lambda: [])
    _provider_slot_snapshot: list[dict[str, Any]] = field(default_factory=lambda: [])
    _extra_backends: list[Backend] = field(default_factory=lambda: [])
    _fault_triggers: list[str] = field(default_factory=lambda: [])

    # Setup and teardown

    async def setup(self, backend_count: int = 3) -> None:
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE harness_instance SET lifecycle_status = 'stopped' WHERE deployment_ref = ANY(%s)",
                    (list(self.api.deployment_refs.values()),),
                )
                cursor = await connection.execute(
                    """
                    SELECT scope, scope_id, slot_number, holder_provider_session_id, reservation_epoch
                    FROM capacity_slot WHERE scope = 'provider' AND scope_id = ANY(%s)
                    """,
                    (list(PROVIDERS),),
                )
                self._provider_slot_snapshot = [dict(row) for row in await cursor.fetchall()]
                await connection.execute(
                    "DELETE FROM capacity_slot WHERE scope = 'provider' AND scope_id = ANY(%s)", (list(PROVIDERS),)
                )
        for _ in range(backend_count):
            self.backends.append(await self._build_backend())

    async def backend(
        self,
        *,
        dsn: str = APP_ROLE_DSN,
        valkey_url: str = VALKEY_URL,
        policy: RatePolicy = LAB_RATE_POLICY,
        faulty_store: bool = False,
    ) -> Backend:
        """A further backend instance. Unreachable DSNs, counter stores or release stores make outages."""
        backend = await self._build_backend(dsn=dsn, valkey_url=valkey_url, policy=policy, faulty_store=faulty_store)
        self._extra_backends.append(backend)
        return backend

    async def _build_backend(
        self,
        *,
        dsn: str = APP_ROLE_DSN,
        valkey_url: str = VALKEY_URL,
        policy: RatePolicy = LAB_RATE_POLICY,
        faulty_store: bool = False,
    ) -> Backend:
        db = await open_db(dsn) if dsn == APP_ROLE_DSN else await _unreachable_db(dsn)
        limiter = connect_rate_limiter(valkey_url, scope_key=self.scope_key, timeout_seconds=0.5)
        registry = self.api.registry
        if faulty_store:
            registry, store = self.api.faulty_registry()
            store.failure = lambda: OSError("release store unreachable")
        deps = self.api.dependencies(db=db, registry=registry)
        service = ConversationService(
            db,
            deps.releases,
            release_id=deps.settings.brain_release_id,
            runtimes=deps.runtimes,
            candidate_policy=deps.candidate_policy,
        )
        controller = AdmissionController(db, service, rates=limiter, rate_policy=policy)
        return Backend(db=db, service=service, limiter=limiter, controller=controller)

    async def close(self) -> None:
        for holder in self._holders:
            await holder.release()
        for name in self._fault_triggers:
            await self._drop_fault(name)
        if self.counter_keys:
            client = open_counter_client(VALKEY_URL, timeout_seconds=1.0)
            try:
                await client.delete(*self.counter_keys)
            finally:
                await client.aclose()
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM capacity_slot WHERE scope_id = ANY(%s)", (self.instances,))
                await connection.execute(
                    "UPDATE harness_instance SET lifecycle_status = 'stopped' WHERE id = ANY(%s::uuid[])",
                    (self.instances,),
                )
                await connection.execute(
                    "DELETE FROM capacity_slot WHERE scope = 'provider' AND scope_id = ANY(%s)", (list(PROVIDERS),)
                )
                for row in self._provider_slot_snapshot:
                    await connection.execute(
                        """
                        INSERT INTO capacity_slot (
                            scope, scope_id, slot_number, holder_provider_session_id, reservation_epoch
                        ) VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            row["scope"],
                            row["scope_id"],
                            row["slot_number"],
                            row["holder_provider_session_id"],
                            row["reservation_epoch"],
                        ),
                    )
        for backend in [*self.backends, *self._extra_backends]:
            await backend.limiter.aclose()
            await backend.db.close()

    # World building

    async def fresh_pool(self, instances: Sequence[tuple[int, int]], *, provider_limit: int) -> list[str]:
        """Stop every earlier lab instance, reset the provider budget, then add `(resident, active)` instances."""
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE harness_instance SET lifecycle_status = 'stopped' WHERE id = ANY(%s::uuid[])",
                    (self.instances,),
                )
                await connection.execute(
                    "DELETE FROM capacity_slot WHERE scope = 'provider' AND scope_id = %s", (PROVIDER,)
                )
        self.pool = []
        await self.set_provider(limit=provider_limit)
        return [await self.add_instance(resident=resident, active=active) for resident, active in instances]

    async def add_instance(
        self,
        *,
        resident: int = 2,
        active: int = 2,
        storage_unit: str | None = None,
        heartbeat_age_seconds: int = 0,
    ) -> str:
        instance_id = str(uuid.uuid4())
        unit = storage_unit or f"test-admission-volume-{instance_id[:8]}"
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO harness_instance (
                        id, provider, worker_id, process_incarnation_id, deployment_ref, native_storage_unit_id,
                        lifecycle_status, resident_session_limit, active_turn_limit, last_heartbeat_at
                    ) VALUES (
                        %s, %s, 'test-admission-worker', %s, %s, %s, 'ready', %s, %s,
                        now() - make_interval(secs => %s)
                    )
                    """,
                    (
                        instance_id,
                        PROVIDER,
                        str(uuid.uuid4()),
                        self.api.deployment_refs[PROVIDER],
                        unit,
                        resident,
                        active,
                        heartbeat_age_seconds,
                    ),
                )
                await provision_instance_slots(Transaction(connection), instance_id)
        self.instances.append(instance_id)
        self.pool.append(instance_id)
        return instance_id

    async def set_provider(self, *, limit: int, healthy: bool = True) -> None:
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO provider_capacity (provider, policy, healthy, active_limit)
                    VALUES (%s, 'test-admission-lab', %s, %s)
                    ON CONFLICT (provider)
                    DO UPDATE SET healthy = EXCLUDED.healthy, active_limit = EXCLUDED.active_limit
                    """,
                    (PROVIDER, healthy, limit),
                )
                await provision_provider_slots(Transaction(connection), PROVIDER)

    async def set_instance(self, instance_id: str, **changes: object) -> None:
        allowed = {"lifecycle_status", "process_incarnation_id", "resident_session_limit", "active_turn_limit"}
        if not set(changes) <= allowed:
            raise ValueError("unsupported instance change")
        assignments = ", ".join(f"{name} = %s" for name in changes)
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    cast(LiteralString, f"UPDATE harness_instance SET {assignments} WHERE id = %s"),
                    (*changes.values(), instance_id),
                )
                await provision_instance_slots(Transaction(connection), instance_id)

    async def drop_unheld_slots(self, instance_id: str, scope: SlotScope) -> None:
        """Unprovision a budget's free rows while its limit still promises capacity."""
        await self._execute(
            "DELETE FROM capacity_slot WHERE scope = %s AND scope_id = %s AND holder_provider_session_id IS NULL",
            (scope, instance_id),
        )

    async def conversation(self, subject_id: str | None = None) -> Conv:
        subject = subject_id or f"test-admission-subject-{uuid.uuid4().hex[:12]}"
        view = await self.backends[0].service.create_conversation(subject, PROVIDER)
        self.track_counter(subject, LAB_RATE_POLICY)
        return Conv(subject_id=subject, conversation_id=view.id)

    def track_counter(self, subject_id: str, policy: RatePolicy) -> None:
        """Remember the subject's opaque counter key so the lab deletes it from Valkey when it closes."""
        self.counter_keys.add(self.backends[0].limiter.key_for(subject_id, policy))

    # Admission

    async def admit(
        self,
        conv: Conv,
        request_id: str | None = None,
        *,
        backend: Backend | int = 0,
        subject_id: str | None = None,
    ) -> AdmissionResult:
        selected = self.backends[backend] if isinstance(backend, int) else backend
        subject = conv.subject_id if subject_id is None else subject_id
        started = time.perf_counter()
        result = await selected.controller.try_admit(
            subject, conv.conversation_id, request_id or f"req-{uuid.uuid4().hex[:12]}"
        )
        self.latencies.append(time.perf_counter() - started)
        return result

    async def submit(self, conv: Conv, request_id: str, message: str, *, backend: int = 0) -> AdmissionResult:
        """Admission followed by the stand-in native submission. The message lives only in this call."""
        result = await self.admit(conv, request_id, backend=backend)
        if isinstance(result, Admitted) and message:
            self.native_submissions[request_id] += 1
        return result

    async def race(self, calls: Sequence[tuple[Conv, str]]) -> list[AdmissionResult]:
        """Every call at once, spread round-robin over the independent backends."""
        start = asyncio.Event()

        async def one(index: int, conv: Conv, request_id: str) -> AdmissionResult:
            await start.wait()
            return await self.admit(conv, request_id, backend=index % len(self.backends))

        tasks = [asyncio.create_task(one(index, conv, req)) for index, (conv, req) in enumerate(calls)]
        await asyncio.sleep(0)
        start.set()
        return list(await asyncio.gather(*tasks))

    # Stand-ins for later tasks' state changes, written through the production fence where one exists

    async def complete_setup(self, admitted: Admitted, native_session_id: str) -> None:
        """Task 16 stand-in: register the native ID through the fenced path and mark the run running."""
        registered = await register_native_session(
            self.admin,
            admitted.reservation.provider_session_id,
            admitted.reservation.ownership_epoch,
            native_session_id,
        )
        if not registered:
            raise AssertionError("native registration was refused")
        await self._execute(
            "UPDATE provider_session SET runtime_state = 'running' WHERE id = %s",
            (admitted.reservation.provider_session_id,),
        )

    async def record_native_work(self, admitted: Admitted, native_work_ref: str) -> None:
        await self._execute(
            "UPDATE provider_session SET current_native_work_ref = %s WHERE id = %s",
            (native_work_ref, admitted.reservation.provider_session_id),
        )

    async def idle_in_state(self, conv: Conv, runtime_state: str) -> None:
        """Recovery stand-in for a session with no run of its own: no guard, no run, the given state."""
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s",
                    (conv.conversation_id,),
                )
                await connection.execute(
                    """
                    UPDATE provider_session
                    SET runtime_state = %s, active_agent_run_id = NULL, current_request_id = NULL
                    WHERE conversation_id = %s AND is_current
                    """,
                    (runtime_state, conv.conversation_id),
                )

    # Other backends' locks

    async def hold_conversation(self, conv: Conv) -> LockHolder:
        return await self._hold("SELECT id FROM conversation WHERE id = %s FOR UPDATE", (conv.conversation_id,))

    async def hold_mapping(self, conv: Conv) -> LockHolder:
        return await self._hold(
            "SELECT id FROM provider_session WHERE conversation_id = %s AND is_current FOR UPDATE",
            (conv.conversation_id,),
        )

    async def hold_free_slots(self, scope: SlotScope, scope_id: str) -> LockHolder:
        """Lock every unheld slot row of one budget without claiming it: committed capacity stays free."""
        return await self._hold(
            """
            SELECT slot_number FROM capacity_slot
            WHERE scope = %s AND scope_id = %s AND holder_provider_session_id IS NULL
            FOR UPDATE
            """,
            (scope, scope_id),
        )

    async def _hold(self, query: str, params: tuple[object, ...]) -> LockHolder:
        connection = await AsyncConnection.connect(APP_ROLE_DSN, autocommit=False)
        cursor = await connection.execute(cast(LiteralString, query), params)
        rows = await cursor.fetchall()
        holder = LockHolder(connection=connection, locked_rows=len(rows))
        self._holders.append(holder)
        return holder

    @asynccontextmanager
    async def mapping_write_fault(self, conv: Conv) -> AsyncGenerator[None]:
        """Fail every provider_session write for this one synthetic conversation, after slots are claimed."""
        name = f"esp_test_fault_{uuid.uuid4().hex[:12]}"
        conversation_id = str(uuid.UUID(conv.conversation_id))
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    cast(
                        LiteralString,
                        f"""
                        CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN
                            RAISE EXCEPTION 'injected admission fault' USING ERRCODE = '58000';
                        END;
                        $$
                        """,
                    )
                )
                await connection.execute(
                    cast(
                        LiteralString,
                        f"""
                        CREATE TRIGGER {name} BEFORE INSERT OR UPDATE ON provider_session
                        FOR EACH ROW WHEN (NEW.conversation_id = '{conversation_id}'::uuid)
                        EXECUTE FUNCTION {name}()
                        """,
                    )
                )
        self._fault_triggers.append(name)
        try:
            yield
        finally:
            await self._drop_fault(name)
            self._fault_triggers.remove(name)

    async def _drop_fault(self, name: str) -> None:
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(cast(LiteralString, f"DROP TRIGGER IF EXISTS {name} ON provider_session"))
                await connection.execute(cast(LiteralString, f"DROP FUNCTION IF EXISTS {name}()"))

    # Observations

    async def held_slots(self) -> list[SlotRow]:
        """Every held slot of the current pool's instances and of the provider budget."""
        rows = await self._fetch(
            """
            SELECT scope, scope_id, slot_number, holder_provider_session_id::text AS holder, reservation_epoch
            FROM capacity_slot
            WHERE holder_provider_session_id IS NOT NULL
              AND (scope_id = ANY(%s) OR (scope = 'provider' AND scope_id = %s))
            ORDER BY scope, scope_id, slot_number
            """,
            (self.pool, PROVIDER),
        )
        return [
            SlotRow(
                scope=str(row["scope"]),
                scope_id=str(row["scope_id"]),
                slot_number=int(row["slot_number"]),
                holder=None if row["holder"] is None else str(row["holder"]),
                epoch=None if row["reservation_epoch"] is None else int(row["reservation_epoch"]),
            )
            for row in rows
        ]

    async def mapping(self, conv: Conv) -> dict[str, Any] | None:
        rows = await self._fetch(
            """
            SELECT id::text AS id, session_generation, native_session_id, model, deployment_ref, runtime_state,
                   harness_instance_id::text AS harness_instance_id,
                   runtime_incarnation_id::text AS runtime_incarnation_id, native_storage_unit_id, state_location,
                   ownership_epoch, active_agent_run_id::text AS active_agent_run_id, current_request_id,
                   current_native_work_ref, owner_lease_expires_at, active_agent_run_expires_at,
                   cancel_requested_at, last_used_at
            FROM provider_session WHERE conversation_id = %s AND is_current
            """,
            (conv.conversation_id,),
        )
        return rows[0] if rows else None

    async def mapping_count(self, conv: Conv) -> int:
        rows = await self._fetch(
            "SELECT count(*) AS n FROM provider_session WHERE conversation_id = %s", (conv.conversation_id,)
        )
        return int(rows[0]["n"])

    async def guard(self, conv: Conv) -> str | None:
        rows = await self._fetch(
            "SELECT active_provider_session_id::text AS guard FROM conversation WHERE id = %s",
            (conv.conversation_id,),
        )
        value = rows[0]["guard"]
        return None if value is None else str(value)

    async def application_tables(self) -> set[str]:
        rows = await self._fetch(
            """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            """,
            (),
        )
        return {str(row["table_name"]) for row in rows}

    async def _fetch(self, query: str, params: tuple[object, ...]) -> list[dict[str, Any]]:
        async with self.admin.pool.connection() as connection:
            cursor = await connection.execute(cast(LiteralString, query), params)
            return [dict(row) for row in await cursor.fetchall()]

    async def _execute(self, query: str, params: tuple[object, ...]) -> None:
        async with self.admin.pool.connection() as connection:
            await connection.execute(cast(LiteralString, query), params)

    # The plan's named scenarios. Each builds its own pool so earlier scenarios cannot leak capacity.

    async def contended_guard_without_owner(self) -> Rejected:
        """Another backend holds the conversation row lock; nobody owns the guard."""
        await self.fresh_pool([(2, 2)], provider_limit=4)
        conv = await self.conversation()
        holder = await self.hold_conversation(conv)
        try:
            result = await self.admit(conv, "req-contended")
            guard = await self.guard(conv)
        finally:
            await holder.release()
        if guard is not None:
            raise AssertionError("the contended guard gained an owner")
        return rejected(result)

    async def confirmed_conflicting_guard(self) -> Rejected:
        """A committed admission owns the guard; a different request arrives."""
        await self.fresh_pool([(2, 2)], provider_limit=4)
        conv = await self.conversation()
        owner = await self.admit(conv, "req-owner")
        if not isinstance(owner, Admitted):
            raise AssertionError(f"the owning admission was not admitted: {owner!r}")
        return rejected(await self.admit(conv, "req-other"))

    async def all_compatible_slots_committed_full(self) -> Rejected:
        """Committed admissions hold every active slot of every compatible instance."""
        await self.fresh_pool([(2, 1), (2, 1)], provider_limit=4)
        for _ in range(2):
            filled = await self.admit(await self.conversation())
            if not isinstance(filled, Admitted):
                raise AssertionError(f"filling admission was not admitted: {filled!r}")
        return rejected(await self.admit(await self.conversation()))

    async def locked_slots_with_free_capacity(self) -> Rejected:
        """Another backend has locked every free active slot without claiming it."""
        (instance,) = await self.fresh_pool([(2, 2)], provider_limit=4)
        conv = await self.conversation()
        holder = await self.hold_free_slots("active", instance)
        try:
            if holder.locked_rows != 2:
                raise AssertionError("the holder did not lock both free active slots")
            result = await self.admit(conv)
        finally:
            await holder.release()
        return rejected(result)

    async def native_submissions_after_reject_then_free(self) -> int:
        """Reject on full capacity, then free that capacity: the rejected input must never run."""
        await self.fresh_pool([(2, 1)], provider_limit=4)
        first = await self.admit(await self.conversation(), "req-first")
        if not isinstance(first, Admitted):
            raise AssertionError(f"first admission was not admitted: {first!r}")
        waiting = await self.conversation()
        refused = await self.submit(waiting, "req-rejected", "a visitor draft that must not run later")
        if not isinstance(refused, Rejected) or refused.code != "capacity_unavailable":
            raise AssertionError(f"expected capacity_unavailable, got {refused!r}")
        if not await self.backends[0].controller.release_unsubmitted(first.authority):
            raise AssertionError("the unsubmitted reservation was not released")
        await asyncio.sleep(0.3)
        if await self.mapping_count(waiting) != 0 or await self.guard(waiting) is not None:
            raise AssertionError("the rejected request left a reservation behind")
        return self.native_submissions["req-rejected"]


def rejected(result: AdmissionResult) -> Rejected:
    if not isinstance(result, Rejected):
        raise AssertionError(f"expected a clean rejection, got {result!r}")
    return result


async def _unreachable_db(dsn: str) -> Db:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
        conninfo=dsn,
        min_size=1,
        max_size=1,
        timeout=0.5,
        kwargs={"row_factory": dict_row, "connect_timeout": 1},
        open=False,
    )
    await pool.open(wait=False)
    return Db(pool)


async def open_admission_lab(tmp_path: Path, *, backend_count: int = 3) -> AdmissionLab:
    api = await open_api_lab(tmp_path)
    lab = AdmissionLab(api=api, admin=api.admin, scope_key=secrets.token_bytes(32))
    try:
        await lab.setup(backend_count)
    except BaseException:
        await close_api_lab(api)
        raise
    return lab


async def close_admission_lab(lab: AdmissionLab) -> None:
    try:
        await lab.close()
    finally:
        await close_api_lab(lab.api)


# Rate counters


@dataclass
class RateLab:
    """Independent counter clients sharing one HMAC scope key, plus a raw client for inspection."""

    scope_key: bytes
    limiters: list[ValkeyRateLimiter]
    raw: Redis
    keys: set[str] = field(default_factory=lambda: set[str]())

    def key(self, subject_id: str, policy: RatePolicy) -> str:
        key = self.limiters[0].key_for(subject_id, policy)
        self.keys.add(key)
        return key

    async def entry(self, key: str) -> dict[str, str]:
        raw = await self.raw.hgetall(key)
        return {_text(name): _text(value) for name, value in raw.items()}

    async def close(self) -> None:
        try:
            if self.keys:
                await self.raw.delete(*self.keys)
        finally:
            for limiter in self.limiters:
                await limiter.aclose()
            await self.raw.aclose()


def _text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


async def open_rate_lab(clients: int = 4) -> RateLab:
    scope_key = secrets.token_bytes(32)
    limiters = [connect_rate_limiter(VALKEY_URL, scope_key=scope_key, timeout_seconds=0.5) for _ in range(clients)]
    return RateLab(scope_key=scope_key, limiters=limiters, raw=open_counter_client(VALKEY_URL, timeout_seconds=1.0))
