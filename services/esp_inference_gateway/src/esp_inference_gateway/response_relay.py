"""Stream provider bytes after the dispatch transaction has finished."""

from collections.abc import AsyncIterator

from fastapi.responses import StreamingResponse

from esp_contracts.runtime import ProviderResponse

_ALLOWED = {"content-type", "cache-control"}


async def _passthrough(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    async for chunk in chunks:
        yield chunk


def relay_response(response: ProviderResponse) -> StreamingResponse:
    headers = {name: value for name, value in response.headers.items() if name.lower() in _ALLOWED}
    return StreamingResponse(_passthrough(response.body), status_code=response.status, headers=headers)
