"""Bounded psycopg pool. Statements do not retry."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from typing import Any, LiteralString, cast

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

Params = tuple[Any, ...] | Mapping[str, Any]


class Transaction:
    def __init__(self, connection: AsyncConnection[dict[str, Any]]) -> None:
        self.connection = connection

    async def execute(self, query: str, params: Params = ()) -> list[dict[str, Any]]:
        cursor = await self.connection.execute(cast(LiteralString, query), params)
        if cursor.description is None:
            return []
        return await cursor.fetchall()

    async def execute_one(self, query: str, params: Params = ()) -> dict[str, Any] | None:
        rows = await self.execute(query, params)
        return rows[0] if rows else None


class Db:
    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]) -> None:
        self.pool = pool

    async def close(self) -> None:
        await self.pool.close()


async def open_db(dsn: str) -> Db:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
        conninfo=dsn,
        min_size=1,
        max_size=4,
        timeout=5,
        kwargs={
            "row_factory": dict_row,
            "options": "-c statement_timeout=5000 -c lock_timeout=2000",
        },
        open=False,
    )
    await pool.open()
    return Db(pool)


@asynccontextmanager
async def transaction(db: Db) -> AsyncGenerator[Transaction, None]:
    async with db.pool.connection() as connection:
        async with connection.transaction():
            yield Transaction(connection)
