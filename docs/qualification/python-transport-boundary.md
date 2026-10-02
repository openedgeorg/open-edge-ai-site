# Python transport boundary

This note records what the local gateway tests actually observed. It is not a Gate 1 or production qualification result.

## Pinned stack

- httpx 0.28.1
- httpcore 1.0.9
- anyio 4.15.1
- Forwarding path: `httpcore.AsyncConnectionPool` with `retries=0` and HTTP/2 disabled
- Network backend: `httpcore._backends.anyio.AnyIOBackend`

The pool is constructed in process. It does not read environment proxies, does not follow redirects, and does not retry a provider request.

## Proved cleartext handoff

The write hook is `httpcore._backends.anyio.AnyIOStream.write`, which calls `anyio.abc.ByteStream.send` on the TCP stream. For cleartext HTTP/1.1 that call is the socket handoff.

`tests/integration/test_dispatch_boundary.py` pauses inside that hook before `send`. The peer does not observe the request body until the hook is released. The shared PostgreSQL advisory fence is still held at that moment. After `send` returns, `with_dispatch_authority` commits and a second connection can take the exclusive fence while the peer is still withholding response headers. The database transaction does not wait for those headers.

`tests/integration/test_gateway_pipeline.py` and `tests/integration/test_evidence_audit.py` also show:

- evidence acknowledgement of the encrypted body and proof happens before connect
- an evidence-store failure, a lost database, an expired lease, and a revocation that already holds the exclusive fence produce zero provider starts
- a dispatch that has entered the write hook rejects a concurrent mapping revoke
- the peer body equals the decrypted evidence object
- the same evidence receipt cannot be started again, and a mismatched request hash does not connect
- 302 and 429 responses are relayed once and are not retried
- a dropped upstream response is not retried
- a lost outcome acknowledgement does not start another provider request
- two concurrent upstreams receive only their own request bytes
- split UTF-8 response chunks are relayed without being decoded into text
- caller `authorization` and `esp-inference-token` headers are not forwarded; the gateway adds its own credential

## Not proved

`AnyIOStream.start_tls` returns a new stream whose `write` method receives plaintext. anyio then writes TLS records on the raw socket underneath that stream. httpcore 1.0.9 does not expose a separate hook for the ciphertext socket write. These tests use cleartext HTTP to a local peer. They do not prove buffering inside TLS, a production OpenAI or xAI connection, or the real runtime profile.

That production handoff remains pending. A green pytest run of this package is not a qualification pass. Gate 1 has to repeat the proof against the selected runtime and provider endpoints.
