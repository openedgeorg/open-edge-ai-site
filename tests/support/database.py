"""Disposable PostgreSQL lab for current-authority constraints."""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime

import psycopg
import pytest

from esp_contracts.runtime import AuthorityRecord
from esp_db.authority import read_current_authority
from esp_db.client import Db, open_db
from scripts.migrate import migrate

APP_DSN = os.environ.get("ESP_DATABASE_URL", "postgresql://esp:esp@127.0.0.1:54329/esp")
GATEWAY_DSN = os.environ.get("ESP_GATEWAY_DATABASE_URL", "postgresql://esp_gateway:esp_gateway@127.0.0.1:54329/esp")
HASH = "a" * 64


class SqlLab:
    def __init__(self, app: Db, gateway: Db, readable_session_id: str) -> None:
        self.app = app
        self.gateway = gateway
        self.readable_session_id = readable_session_id

    async def change_provider_sqlstate(self) -> str:
        conversation_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, conversation_id, "openai")
            await connection.execute(
                "UPDATE conversation SET provider = 'xai' WHERE id = %s",
                (conversation_id,),
            )

        return await self._sqlstate(work)

    async def second_current_mapping_sqlstate(self) -> str:
        conversation_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, conversation_id, "openai")
            await _insert_session(connection, uuid.uuid4(), conversation_id, "openai", 1, True)
            await _insert_session(connection, uuid.uuid4(), conversation_id, "openai", 2, True)

        return await self._sqlstate(work)

    async def foreign_guard_sqlstate(self) -> str:
        owned = uuid.uuid4()
        other = uuid.uuid4()
        session_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, owned, "openai")
            await _insert_conversation(connection, other, "openai")
            await _insert_session(connection, session_id, owned, "openai", 1, True)
            await connection.execute(
                "UPDATE conversation SET active_provider_session_id = %s WHERE id = %s",
                (session_id, other),
            )

        return await self._sqlstate(work)

    async def gateway_write_sqlstate(self) -> str:
        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, uuid.uuid4(), "openai")

        return await self._sqlstate(work, self.gateway)

    async def application_tables(self) -> set[str]:
        async with self.app.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                """
            )
            rows = await cursor.fetchall()
        return {str(row["table_name"]) for row in rows}

    async def pin_mutation_sqlstate(self) -> str:
        conversation_id = uuid.uuid4()
        session_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, conversation_id, "openai")
            await _insert_session(connection, session_id, conversation_id, "openai", 1, True)
            await connection.execute(
                "UPDATE provider_session SET brain_hash = %s WHERE id = %s",
                ("b" * 64, session_id),
            )

        return await self._sqlstate(work)

    async def decreasing_epoch_sqlstate(self) -> str:
        conversation_id = uuid.uuid4()
        session_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, conversation_id, "openai")
            await _insert_session(connection, session_id, conversation_id, "openai", 1, True)
            await connection.execute(
                "UPDATE provider_session SET ownership_epoch = ownership_epoch - 1 WHERE id = %s",
                (session_id,),
            )

        return await self._sqlstate(work)

    async def mismatched_generation_sqlstate(self) -> str:
        conversation_id = uuid.uuid4()

        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await _insert_conversation(connection, conversation_id, "openai")
            await _insert_session(connection, uuid.uuid4(), conversation_id, "xai", 1, True)

        return await self._sqlstate(work)

    async def incomplete_validated_record_sqlstate(self) -> str:
        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await connection.execute(
                """
                INSERT INTO runtime_qualification (id, design_assumption_id, provider, status)
                VALUES (%s, 'DA-01', 'openai', 'validated')
                """,
                (f"incomplete-{uuid.uuid4()}",),
            )

        return await self._sqlstate(work)

    async def gateway_authority(self) -> AuthorityRecord | None:
        return await read_current_authority(self.gateway, self.readable_session_id)

    async def gateway_base_table_sqlstate(self) -> str:
        async def work(connection: psycopg.AsyncConnection[dict[str, object]]) -> None:
            await connection.execute("SELECT id FROM conversation")

        return await self._sqlstate(work, self.gateway)

    async def _sqlstate(
        self,
        work: Callable[[psycopg.AsyncConnection[dict[str, object]]], Awaitable[None]],
        database: Db | None = None,
    ) -> str:
        target = self.app if database is None else database
        try:
            async with target.pool.connection() as connection:
                async with connection.transaction():
                    await work(connection)
        except psycopg.Error as exc:
            if exc.sqlstate is None:
                raise
            return exc.sqlstate
        raise AssertionError("constraint did not reject the write")


def _now() -> datetime:
    return datetime.now(UTC)


async def _insert_conversation(
    connection: psycopg.AsyncConnection[dict[str, object]], conversation_id: uuid.UUID, provider: str
) -> None:
    now = _now()
    await connection.execute(
        """
        INSERT INTO conversation (
            id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
            corpus_release_id, status, created_at, updated_at
        ) VALUES (%s, 'subject-a', %s, 'fixture-brain', 'behavior-a', %s, 'fixture-corpus', 'active', %s, %s)
        """,
        (conversation_id, provider, HASH, now, now),
    )


async def _insert_session(
    connection: psycopg.AsyncConnection[dict[str, object]],
    session_id: uuid.UUID,
    conversation_id: uuid.UUID,
    provider: str,
    generation: int,
    current: bool,
) -> None:
    now = _now()
    await connection.execute(
        """
        INSERT INTO provider_session (
            id, conversation_id, provider, session_generation, is_current, brain_release_id, brain_hash,
            behavior_version, behavior_hash, corpus_release_id, deployment_ref, runtime_state,
            ownership_epoch, recovery_count, created_at, last_used_at
        ) VALUES (
            %s, %s, %s, %s, %s, 'fixture-brain', %s, 'behavior-a', %s, 'fixture-corpus', 'deployment-fixture',
            'warm_idle', 1, 0, %s, %s
        )
        """,
        (session_id, conversation_id, provider, generation, current, HASH, HASH, now, now),
    )


@pytest.fixture(scope="session")
async def sql_lab() -> AsyncIterator[SqlLab]:
    await migrate(APP_DSN)
    await migrate(APP_DSN)
    app = await open_db(APP_DSN)
    gateway = await open_db(GATEWAY_DSN)
    conversation_id = uuid.uuid4()
    session_id = uuid.uuid4()
    async with app.pool.connection() as connection:
        async with connection.transaction():
            await _insert_conversation(connection, conversation_id, "openai")
            await _insert_session(connection, session_id, conversation_id, "openai", 1, True)
    lab = SqlLab(app, gateway, str(session_id))
    yield lab
    await app.close()
    await gateway.close()
