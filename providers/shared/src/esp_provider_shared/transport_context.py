"""Per-native-session operation context. Stdio env and profile digests never bind a session."""

from __future__ import annotations

from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, Field

from esp_contracts.ids import Sha256


class UnattributedCall(Exception):
    """A model or tool start had no trusted binding, or a token refresh was not attributable."""


class OperationContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    native_session_id: str
    native_work_ref: str | None
    provider_session_id: str
    session_generation: int
    active_agent_run_id: str
    # Python int, not a JSON number, so epochs above 2^53 stay exact.
    ownership_epoch: int
    runtime_incarnation_id: str
    inference_token: str = Field(min_length=1)
    knowledge_token: str = Field(min_length=1)


class HookProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hook_patch_digest: Sha256
    profile_digest: Sha256


class TransportContext:
    """Bindings are keyed only by `native_session_id` from an explicit `bind`."""

    def __init__(self) -> None:
        self._contexts: dict[str, OperationContext] = {}
        self._stdio_attempts: list[dict[str, str]] = []
        self._profile_inputs: list[HookProfileInput] = []
        self.unattributed_starts = 0
        self._model_starts = 0
        self._tool_starts = 0

    def bind(self, context: OperationContext) -> None:
        self._contexts[context.native_session_id] = context.model_copy()

    def current(self, native_session_id: str) -> OperationContext | None:
        """A copy of the session's current binding, including refreshed tokens, or None."""
        context = self._contexts.get(native_session_id)
        return None if context is None else context.model_copy()

    def unbind(self, native_session_id: str) -> None:
        """Drop the session's binding. Later starts and token refreshes for it are unattributed."""
        self._contexts.pop(native_session_id, None)

    def bind_from_stdio_wrapper(self, env: Mapping[str, str]) -> None:
        """Record the wrapper env and bind nothing."""
        self._stdio_attempts.append(dict(env))

    def note_profile_input(self, profile: HookProfileInput) -> None:
        """Store build/profile digests and bind nothing."""
        self._profile_inputs.append(profile.model_copy())

    def refresh_tokens(self, native_session_id: str, inference_token: str, knowledge_token: str) -> None:
        if inference_token == "" or knowledge_token == "":
            raise UnattributedCall("empty token")
        current = self._contexts.get(native_session_id)
        if current is None:
            raise UnattributedCall("unknown native session")
        self._contexts[native_session_id] = current.model_copy(
            update={"inference_token": inference_token, "knowledge_token": knowledge_token}
        )

    def start_model_call(self, native_session_id: str) -> dict[str, str]:
        context = self._require(native_session_id)
        self._model_starts += 1
        return {
            "audience": "inference",
            "token": context.inference_token,
            "native_session_id": context.native_session_id,
        }

    def start_model_call_for(self, context: OperationContext) -> dict[str, str]:
        """Model start whose owning operation the adapter resolved from the request's own native
        session and work ids. `context` must come from an earlier explicit `bind`; never from a header."""
        self._model_starts += 1
        return {
            "audience": "inference",
            "token": context.inference_token,
            "native_session_id": context.native_session_id,
        }

    def start_tool_call(self, native_session_id: str) -> dict[str, str]:
        context = self._require(native_session_id)
        self._tool_starts += 1
        return {
            "audience": "knowledge",
            "token": context.knowledge_token,
            "native_session_id": context.native_session_id,
        }

    def attributed_model_starts(self) -> int:
        return self._model_starts

    def attributed_tool_starts(self) -> int:
        return self._tool_starts

    def _require(self, native_session_id: str) -> OperationContext:
        context = self._contexts.get(native_session_id)
        if context is None:
            self.unattributed_starts += 1
            raise UnattributedCall("unattributed call")
        return context
