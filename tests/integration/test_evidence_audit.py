"""Independent decryption re-extracts the stored body and the proof."""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest

from esp_inference_gateway.evidence_recorder import EvidenceReceipt
from esp_inference_gateway.transport import TransportError
from tests.support.wire_server import BEHAVIOR, BRAIN, WireLab, build_wire_lab


@pytest.fixture
async def wire_lab(tmp_path: Path) -> AsyncIterator[WireLab]:
    lab = await build_wire_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_audit_extracts_the_stored_request_and_rejects_replay(wire_lab: WireLab) -> None:
    trace = await wire_lab.forward_one()
    assert trace.provider_body == trace.decrypted_evidence_body
    assert b"synthetic-canary brain" not in json.dumps(trace.proof).encode()
    brain = cast(dict[str, Any], trace.proof["brain"])
    behavior = cast(dict[str, Any], trace.proof["behavior"])
    document = json.loads(trace.decrypted_evidence_body)
    instructions = document["instructions"]
    assert isinstance(instructions, str)
    raw = instructions.encode("utf-8")
    extracted_brain = raw[int(brain["start_offset"]) : int(brain["end_offset"])]
    extracted_behavior = raw[int(behavior["start_offset"]) : int(behavior["end_offset"])]
    assert extracted_brain == BRAIN
    assert extracted_behavior == BEHAVIOR
    assert hashlib.sha256(extracted_brain).hexdigest() == brain["sha256"]
    assert trace.proof["request_sha256"] == hashlib.sha256(trace.decrypted_evidence_body).hexdigest()
    assert trace.proof["ownership_epoch"] == "1"
    receipt = EvidenceReceipt(
        inference_id=trace.inference_id,
        request_ref=trace.request_ref,
        proof_ref=trace.proof_ref,
        request_sha256=str(trace.proof["request_sha256"]),
    )
    connects = wire_lab.transport.probe.connects
    route = wire_lab.deps.routes["openai"]
    with pytest.raises(TransportError, match="replay_forbidden"):
        await wire_lab.transport.start(route, trace.provider_body, receipt)
    tampered = receipt.model_copy(update={"inference_id": "inf_tamper", "request_sha256": "b" * 64})
    with pytest.raises(TransportError, match="evidence_mismatch"):
        await wire_lab.transport.start(route, trace.provider_body, tampered)
    assert wire_lab.transport.probe.connects == connects
