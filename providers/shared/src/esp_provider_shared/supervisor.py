"""Authenticated control admission. No workload signing key is stored or accepted."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from esp_contracts.api import SubmitMessage
from esp_contracts.ids import Sha256
from esp_contracts.runtime import OperationAuthority, SessionHandle, SessionReservation, WorkRef
from esp_observability.traces import RecoveryTrace, record_recovery_trace
from esp_provider_shared.adapter import HarnessAdapter
from esp_provider_shared.storage_fence import FenceReceipt, StorageFence

CONTROL_ALLOWLIST = frozenset(
    {
        "create",
        "resume",
        "submit",
        "inspect",
        "history",
        "cancel",
        "unload",
        "continue",
        "token-refresh",
    }
)
OPERATOR_METHODS = frozenset({"export", "delete"})
_FINGERPRINT = re.compile(r"[0-9a-f]{64}")
_CallerRole = Literal["backend", "operator", "anonymous"]
_AnchorRole = Literal["backend", "operator"]


class UnauthorizedControl(Exception):
    """The caller may not invoke this control method."""


class WorkloadKeyForbidden(Exception):
    """A workload identity must not carry or accept signing-key material."""


class ControlCaller(BaseModel):
    model_config = ConfigDict(extra="forbid")

    peer_id: str
    role: _CallerRole
    mtls_authenticated: bool


class TrustAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    peer_id: str
    role: _AnchorRole
    cert_fingerprint: Sha256


def publish_recovery(trace: RecoveryTrace) -> None:
    """Record a recovery observation. A telemetry outage does not change the runtime transition."""
    try:
        record_recovery_trace(trace)
    except Exception:
        return


def authenticate_caller(presented_fingerprint: str | None, anchors: Sequence[TrustAnchor]) -> ControlCaller:
    """Missing, non-hex, or unknown fingerprints are anonymous and unauthenticated."""
    anonymous = ControlCaller(peer_id="", role="anonymous", mtls_authenticated=False)
    if presented_fingerprint is None or _FINGERPRINT.fullmatch(presented_fingerprint) is None:
        return anonymous
    for anchor in anchors:
        if anchor.cert_fingerprint == presented_fingerprint:
            return ControlCaller(peer_id=anchor.peer_id, role=anchor.role, mtls_authenticated=True)
    return anonymous


class Supervisor:
    """Allowlisted control plane over one adapter. `signer` is rejected and never stored."""

    def __init__(
        self,
        adapter: HarnessAdapter,
        fence: StorageFence,
        *,
        instance_id: str,
        signer: object | None = None,
    ) -> None:
        if signer is not None:
            raise WorkloadKeyForbidden("workload signing key is forbidden")
        self._adapter = adapter
        self._fence = fence
        self._instance_id = instance_id
        self._attached: dict[str, str] = {}
        self._recovery_notes: list[RecoveryTrace] = []

    def workload_material(self) -> dict[str, str]:
        return {"instance_id": self._instance_id}

    async def call(self, caller: ControlCaller, method: str, params: dict[str, Any]) -> object:
        self._admit(caller, method)
        if method == "token-refresh":
            return self._refresh_tokens(params)
        if method == "create":
            reservation = SessionReservation.model_validate(params["reservation"])
            return await self._adapter.create_session(reservation)
        if method == "export":
            return await self._adapter.export_history(_parse_handle(params))
        if method == "delete":
            return await self._adapter.delete_history(_parse_handle(params))
        if method == "resume":
            return await self._adapter.resume_session(_parse_handle(params))
        if method == "inspect":
            return await self._adapter.inspect(_parse_handle(params), _optional_str(params.get("request_id")))
        if method == "history":
            return await self._adapter.read_history(_parse_handle(params))
        if method == "unload":
            return await self._adapter.unload(_parse_handle(params))
        if method == "cancel":
            return await self._adapter.cancel(_parse_handle(params), WorkRef.model_validate(params["work"]))
        if method == "submit":
            return await self._adapter.submit(
                _parse_handle(params),
                SubmitMessage.model_validate(_message_body(params)),
                OperationAuthority.model_validate(params["authority"]),
            )
        if method == "continue":
            return await self._adapter.continue_work(
                _parse_handle(params),
                WorkRef.model_validate(params["work"]),
                OperationAuthority.model_validate(params["authority"]),
            )
        raise UnauthorizedControl("method_not_allowlisted")

    async def restart_incarnation(
        self,
        *,
        storage_unit_id: str,
        obsolete_incarnation_id: str,
        replacement_incarnation_id: str,
    ) -> FenceReceipt:
        # Fence first. FenceEvidenceMissing must leave the unit unattached.
        receipt = await self._fence.fence_previous_writer(storage_unit_id, obsolete_incarnation_id)
        self._attached[storage_unit_id] = replacement_incarnation_id
        return receipt

    def attached_incarnation(self, storage_unit_id: str) -> str | None:
        return self._attached.get(storage_unit_id)

    async def consume_independent(self) -> None:
        """Control reconciliation is not an HTTP request and does not admit a caller. `call` does not use this."""
        pending = self._recovery_notes
        self._recovery_notes = []
        for trace in pending:
            publish_recovery(trace)

    def queue_recovery(self, trace: RecoveryTrace) -> None:
        self._recovery_notes.append(trace)

    def _admit(self, caller: ControlCaller, method: str) -> None:
        if not caller.mtls_authenticated or caller.role == "anonymous":
            raise UnauthorizedControl("unauthorized")
        # Operator methods are not on the allowlist; a backend must not look like "unknown method".
        if method in OPERATOR_METHODS:
            if caller.role != "operator":
                raise UnauthorizedControl("operator_permission_required")
            return
        if method not in CONTROL_ALLOWLIST:
            raise UnauthorizedControl("method_not_allowlisted")

    def _refresh_tokens(self, params: Mapping[str, Any]) -> None:
        if "signing_key" in params or "private_key" in params:
            raise WorkloadKeyForbidden("workload signing key is forbidden")
        self._adapter.transport.refresh_tokens(
            params["native_session_id"],
            params["inference_token"],
            params["knowledge_token"],
        )


def _parse_handle(params: Mapping[str, Any]) -> SessionHandle:
    raw = params["handle"] if "handle" in params else params
    return SessionHandle.model_validate(raw)


def _message_body(params: Mapping[str, Any]) -> object:
    if "message" in params:
        return params["message"]
    return params["input"]


def _optional_str(value: object) -> str | None:
    if isinstance(value, str):
        return value
    return None
