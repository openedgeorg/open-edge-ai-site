"""S3-compatible immutable objects. Requests are signed, never redirected, and never retried."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import quote

from esp_contracts.release import ReleaseError
from esp_object_store.store import ObjectReceipt, object_reference


def _encode_key(key: str) -> str:
    return "/".join(quote(part, safe="") for part in key.split("/"))


def _signing_key(secret_key: str, datestamp: str, region: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret_key}".encode(), datestamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def _authorization(
    method: str,
    path: str,
    headers: dict[str, str],
    payload_hash: str,
    access_key: str,
    secret_key: str,
    region: str,
    amz_date: str,
) -> str:
    signed = {name.lower(): " ".join(value.split()) for name, value in headers.items()}
    canonical_headers = "".join(f"{name}:{signed[name]}\n" for name in sorted(signed))
    signed_headers = ";".join(sorted(signed))
    canonical_request = "\n".join([method, path, "", canonical_headers, signed_headers, payload_hash])
    datestamp = amz_date[:8]
    scope = f"{datestamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret_key, datestamp, region),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"


class S3ObjectStore:
    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        *,
        secure: bool = True,
        region: str = "us-east-1",
    ) -> None:
        self.endpoint = endpoint
        self.access_key = access_key
        self.secret_key = secret_key
        self.bucket = bucket
        self.secure = secure
        self.region = region
        if self._status("HEAD", None, b"") == 404:
            status, body = self._exchange("PUT", None, b"")
            if status not in {200, 204} and b"BucketAlreadyOwnedByYou" not in body:
                raise ReleaseError("object_store_unavailable")

    async def put_immutable(self, key: str, body: bytes, metadata: dict[str, str]) -> ObjectReceipt:
        digest = hashlib.sha256(body).hexdigest()
        status = self._status("HEAD", key, b"")
        if status == 200:
            existing = await self.get(key, None)
            if existing != body:
                raise ReleaseError("immutable_conflict")
            return self._receipt(key, digest)
        if status != 404:
            raise ReleaseError("object_store_unavailable")
        put_status, _payload = self._exchange("PUT", key, body, metadata)
        if put_status not in {200, 204}:
            raise ReleaseError("object_store_unavailable")
        return self._receipt(key, digest)

    async def get(self, key: str, version_id: str | None = None) -> bytes:
        status, body = self._exchange("GET", key, b"")
        if status == 404:
            raise ReleaseError("object_unavailable")
        if status != 200:
            raise ReleaseError("object_store_unavailable")
        digest = hashlib.sha256(body).hexdigest()
        if version_id is not None and version_id != digest:
            raise ReleaseError("object_version_mismatch")
        return body

    def _receipt(self, key: str, digest: str) -> ObjectReceipt:
        return ObjectReceipt(version_id=digest, sha256=digest, reference=object_reference(key, digest))

    def _status(self, method: str, key: str | None, body: bytes) -> int:
        status, _payload = self._exchange(method, key, body)
        return status

    def _exchange(
        self,
        method: str,
        key: str | None,
        body: bytes,
        metadata: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        payload_hash = hashlib.sha256(body).hexdigest()
        amz_date = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        path = "/" + quote(self.bucket, safe="")
        if key is not None:
            path += "/" + _encode_key(key)
        headers = {
            "host": self.endpoint,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if metadata is not None:
            for name, value in metadata.items():
                headers[f"x-amz-meta-{name.lower()}"] = value
        if method == "PUT":
            headers["content-length"] = str(len(body))
        headers["authorization"] = _authorization(
            method,
            path,
            {name: value for name, value in headers.items() if name != "authorization"},
            payload_hash,
            self.access_key,
            self.secret_key,
            self.region,
            amz_date,
        )
        connection: HTTPConnection | HTTPSConnection
        if self.secure:
            connection = HTTPSConnection(self.endpoint, timeout=5)
        else:
            connection = HTTPConnection(self.endpoint, timeout=5)
        try:
            connection.request(method, path, body=body if method == "PUT" else None, headers=headers)
            response = connection.getresponse()
            payload = response.read()
            return response.status, payload
        except OSError as exc:
            raise ReleaseError("object_store_unavailable") from exc
        finally:
            connection.close()
