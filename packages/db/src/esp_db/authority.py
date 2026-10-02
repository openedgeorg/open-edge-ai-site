"""Read-only current authority. Callers do not pass pins from a token alone."""

from __future__ import annotations

from esp_contracts.runtime import AuthorityRecord
from esp_db.client import Db, transaction
from esp_db.records import AUTHORITY_COLUMNS


async def read_current_authority(db: Db, provider_session_id: str) -> AuthorityRecord | None:
    columns = ", ".join(AUTHORITY_COLUMNS)
    query = f"SELECT {columns} FROM current_authority WHERE provider_session_id = %s"  # noqa: S608
    async with transaction(db) as tx:
        row = await tx.execute_one(query, (provider_session_id,))
    if row is None:
        return None
    return AuthorityRecord.model_validate(row)
