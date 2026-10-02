"""Apply idempotent SQL migrations to the disposable or configured primary database."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import psycopg

DEFAULT_DSN = "postgresql://esp:esp@127.0.0.1:54329/esp"
MIGRATIONS = Path("infra/migrations")


async def _applied(connection: psycopg.AsyncConnection[tuple[object, ...]]) -> set[str]:
    cursor = await connection.execute("SELECT to_regclass('public.schema_migrations')")
    row = await cursor.fetchone()
    if row is None or row[0] is None:
        return set()
    names = await connection.execute("SELECT filename FROM schema_migrations")
    return {str(item[0]) for item in await names.fetchall()}


async def migrate(dsn: str, directory: Path = MIGRATIONS) -> list[str]:
    applied_now: list[str] = []
    async with await psycopg.AsyncConnection.connect(dsn) as connection:
        already = await _applied(connection)
        for path in sorted(directory.glob("*.sql")):
            if path.name in already:
                continue
            async with connection.transaction():
                script = path.read_text(encoding="utf-8")
                await connection.execute(script, prepare=False)  # type: ignore[call-arg]
                await connection.execute(
                    "INSERT INTO schema_migrations (filename) VALUES (%s)",
                    (path.name,),
                )
            applied_now.append(path.name)
    return applied_now


def main(argv: list[str] | None = None) -> int:
    del argv
    dsn = os.environ.get("ESP_DATABASE_URL", DEFAULT_DSN)
    applied = asyncio.run(migrate(dsn))
    if applied:
        print("applied " + ", ".join(applied))
    else:
        print("migrations already applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
