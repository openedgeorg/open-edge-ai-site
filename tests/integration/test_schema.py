"""Task 3: current-authority schema rejects provider changes, foreign guards and gateway writes."""

from __future__ import annotations

import pytest

from tests.support.database import SqlLab


@pytest.mark.asyncio
async def test_schema_enforces_current_identity(sql_lab: SqlLab) -> None:
    assert await sql_lab.change_provider_sqlstate() == "23514"
    assert await sql_lab.second_current_mapping_sqlstate() == "23505"
    assert await sql_lab.foreign_guard_sqlstate() == "23514"
    assert await sql_lab.gateway_write_sqlstate() == "42501"
    assert not {"message", "turn", "job"} & await sql_lab.application_tables()


@pytest.mark.asyncio
async def test_pins_epoch_generation_and_validated_rows(sql_lab: SqlLab) -> None:
    assert await sql_lab.pin_mutation_sqlstate() == "23514"
    assert await sql_lab.decreasing_epoch_sqlstate() == "23514"
    assert await sql_lab.mismatched_generation_sqlstate() == "23514"
    assert await sql_lab.incomplete_validated_record_sqlstate() == "23514"


@pytest.mark.asyncio
async def test_gateway_reads_authority_and_cannot_read_base_tables(sql_lab: SqlLab) -> None:
    record = await sql_lab.gateway_authority()
    assert record is not None
    assert record.provider == "openai"
    assert await sql_lab.gateway_base_table_sqlstate() == "42501"
