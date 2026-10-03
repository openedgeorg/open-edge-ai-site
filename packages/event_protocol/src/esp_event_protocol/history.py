"""Authorized native history for the public boundary (P §§11.1, 12.8; D5).

The owning harness keeps an ESP Conversation (EspCon)'s history. The Application Backend reads it through
that harness's adapter for each request and keeps no copy: there is no application transcript. This
module only narrows a native snapshot to what the conversation's owner may see:

- provenance is kept only when it names this conversation and its own native session, so a peer
  session's source or tool observations never appear;
- a citation verification state that came from native history is model output, so `verified` is
  lowered to `unverified`; only server-side verification may mark a citation verified;
- assistant output of native work that is still open (running, interrupted or of unknown outcome) is
  provisional, so a reconnecting browser replaces it rather than appending to it;
- a repeated native item ID is kept once, in its first position.

`empty_history` is the snapshot of a conversation with no native session yet. Callers use it only before
allocation; history that exists but cannot be read is unavailable, never this empty snapshot.
"""

from __future__ import annotations

from esp_contracts.api import Citation, StructuredData
from esp_contracts.runtime import HistoryItem, NativeHistorySnapshot, NativeStatus, NativeWorkStatus

_OPEN_WORK: frozenset[NativeWorkStatus] = frozenset({"running", "interrupted", "unknown"})


def empty_history() -> NativeHistorySnapshot:
    """No native session exists yet, so nothing was saved and no work exists."""
    return NativeHistorySnapshot(
        items=[],
        native_cursor=None,
        status=NativeStatus(status="idle", saved_input_available=False),
        provenance=[],
    )


def authorized_history(
    snapshot: NativeHistorySnapshot, *, conversation_id: str, native_session_id: str
) -> NativeHistorySnapshot:
    """The owner's view of one native snapshot read from the conversation's own native session."""
    status = snapshot.status
    open_work = status.native_work_ref if status.status in _OPEN_WORK else None
    seen: set[str] = set()
    items: list[HistoryItem] = []
    for item in snapshot.items:
        if item.native_item_id in seen:
            continue
        seen.add(item.native_item_id)
        provisional = item.provisional or (
            item.role == "assistant" and open_work is not None and item.native_work_ref == open_work
        )
        items.append(
            item.model_copy(
                update={
                    "citations": [_untrusted(citation) for citation in item.citations],
                    "structured_data": [_untrusted_table(table) for table in item.structured_data],
                    "provisional": provisional,
                }
            )
        )
    provenance = [
        entry
        for entry in snapshot.provenance
        if entry.conversation_id == conversation_id and entry.native_session_id == native_session_id
    ]
    return NativeHistorySnapshot(
        items=items,
        native_cursor=snapshot.native_cursor,
        status=status,
        provenance=provenance,
    )


def _untrusted(citation: Citation) -> Citation:
    if citation.verification_state != "verified":
        return citation
    return citation.model_copy(update={"verification_state": "unverified"})


def _untrusted_table(table: StructuredData) -> StructuredData:
    return table.model_copy(update={"citation": _untrusted(table.citation)})


__all__ = ["authorized_history", "empty_history"]
