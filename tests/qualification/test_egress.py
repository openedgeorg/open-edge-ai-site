"""Live egress enforcement from the actual runtime pod network (run only via scripts/qualify.py).

The direct-egress probe runs in an ephemeral container attached to the running runtime pod, so it
shares that pod's network namespace and therefore its NetworkPolicy. Only a connection that never
completes counts as denied; any completed TCP connection or HTTP status (including a provider `401`)
is a bypass. A name that does not resolve in the pod is DNS-only evidence: the probe then attempts the
addresses observed outside the cluster, so every verdict rests on an IP-level attempt.

The forward-proxy probe runs inside the runtime container itself (`kubectl exec`), because only there
does it hold the runtime's own mounted mTLS identity. An authenticated runtime is what must not be
able to use the gateway as a proxy; a handshake refused to an identity-less caller proves nothing.
"""

from __future__ import annotations

import json
import socket
from typing import Any

import pytest

from scripts.qualify import (
    EgressAttempt,
    direct_egress_outcome,
    dns_internal_only_outcome,
    forward_proxy_outcome,
)
from tests.support.qualification_cluster import QualificationCluster

PROVIDER_HOSTS = {"openai": "api.openai.com", "xai": "api.x.ai"}
ALTERNATE_MODEL_HOSTS = {
    "openai": ("api.x.ai", "chatgpt.com", "api.anthropic.com", "generativelanguage.googleapis.com"),
    "xai": ("api.openai.com", "grok.com", "api.anthropic.com", "generativelanguage.googleapis.com"),
}
GATEWAY = "esp-inference-gateway.esp-qualification.svc.cluster.local"
KNOWLEDGE = "esp-knowledge.esp-qualification.svc.cluster.local"
SERVICE_PORT = 8443

# Runs inside the runtime image. Standard library only; never sends a provider credential. With
# `client_identity` it presents the runtime's mounted mTLS identity (ESP_CONTROL_TLS_DIR) and verifies
# the peer against the mounted CA when present.
PROBE = r"""
import errno, json, os, socket, ssl, sys
NAMES = {errno.ECONNREFUSED: "connection_refused", errno.ECONNRESET: "connection_reset",
         errno.EHOSTUNREACH: "host_unreachable", errno.ENETUNREACH: "network_unreachable",
         errno.ETIMEDOUT: "timeout", errno.EACCES: "permission_denied", errno.EPERM: "permission_denied",
         errno.EAFNOSUPPORT: "address_family_unsupported", errno.EADDRNOTAVAIL: "address_unavailable"}
FAMILIES = {"ipv4": socket.AF_INET, "ipv6": socket.AF_INET6}


def blank(target, host):
    return {"scenario": target["scenario"], "target": "%s:%d" % (host, target["port"]), "resolved": False,
            "tcp_connected": False, "tls_established": None, "http_status": None, "error": None,
            "client_certificate": False, "server_verified": None, "request_form": target.get("request_form")}


def identity_context(out):
    tls_dir = os.environ.get("ESP_CONTROL_TLS_DIR", "/etc/esp/mtls")
    context = ssl.create_default_context()
    context.check_hostname = False
    ca = os.path.join(tls_dir, "ca.crt")
    if os.path.exists(ca):
        context.load_verify_locations(cafile=ca)
        context.verify_mode = ssl.CERT_REQUIRED
    else:
        context.verify_mode = ssl.CERT_NONE
    context.load_cert_chain(os.path.join(tls_dir, "tls.crt"), os.path.join(tls_dir, "tls.key"))
    out["client_certificate"] = True
    return context


def connect(target, out, address, family):
    context = None
    if target.get("client_identity"):
        try:
            context = identity_context(out)
        except (OSError, ssl.SSLError):
            out["error"] = "client_identity_unavailable"
            return out
    sock = None
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(target.get("timeout", 5.0))
        sock.connect(address)
        out["tcp_connected"] = True
        if target.get("tls"):
            if context is None:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=target.get("sni") or target["host"])
            out["tls_established"] = True
            out["server_verified"] = context.verify_mode == ssl.CERT_REQUIRED
        if target.get("request"):
            sock.sendall(target["request"].encode())
            head = sock.recv(64).decode("latin-1")
            if head.startswith("HTTP/"):
                out["http_status"] = int(head.split()[1])
    except socket.timeout:
        out["error"] = "timeout"
    except ssl.SSLError:
        out["error"] = "tls_refused"
    except OSError as exc:
        out["error"] = NAMES.get(exc.errno, "os_error_%s" % exc.errno)
    finally:
        if sock is not None:
            sock.close()
    return out


def attempts(target):
    out = blank(target, target["host"])
    family = FAMILIES.get(target.get("family"), socket.AF_UNSPEC)
    try:
        infos = socket.getaddrinfo(target["host"], target["port"], family, socket.SOCK_STREAM)
        out["resolved"] = True
    except socket.gaierror:
        out["error"] = "name_unresolved"
        results = [out]
        # DNS-only evidence is not a denial: try the addresses observed outside the cluster.
        for address in target.get("fallback_addresses", []):
            try:
                found = socket.getaddrinfo(address, target["port"], 0, socket.SOCK_STREAM,
                                           0, socket.AI_NUMERICHOST)
            except socket.gaierror:
                continue
            item = blank(target, address)
            item["resolved"] = True
            results.append(connect(target, item, found[0][4], found[0][0]))
        return results
    if target.get("resolve_only"):
        return [out]
    return [connect(target, out, infos[0][4], infos[0][0])]


def main(argv):
    for target in json.loads(argv[1]):
        for out in attempts(target):
            print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main(sys.argv)
"""


def _observed_addresses(host: str) -> list[str]:
    """Addresses of a public name as resolved where the qualification driver runs, outside the cluster."""
    try:
        infos = socket.getaddrinfo(host, 443, 0, socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({str(info[4][0]) for info in infos})


def _direct_targets(cluster: QualificationCluster) -> list[dict[str, Any]]:
    provider = cluster.provider
    host = PROVIDER_HOSTS[provider]
    addresses = cluster.environment.provider_addresses[provider]
    recorded = [*addresses.ipv4, *addresses.ipv6]
    https = f"GET /v1/models HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    targets: list[dict[str, Any]] = [
        {
            "scenario": "egress_provider_hostname_denied",
            "host": host,
            "port": 443,
            "tls": True,
            "request": https,
            "fallback_addresses": recorded,
        },
        {
            "scenario": "egress_provider_redirect_hop_denied",
            "host": host,
            "port": 80,
            "request": https,
            "fallback_addresses": recorded,
        },
    ]
    for address in addresses.ipv4:
        targets.append({"scenario": "egress_provider_ipv4_denied", "host": address, "port": 443, "family": "ipv4"})
    for address in addresses.ipv6:
        targets.append({"scenario": "egress_provider_ipv6_denied", "host": address, "port": 443, "family": "ipv6"})
    for alternate in ALTERNATE_MODEL_HOSTS[provider]:
        targets.append(
            {
                "scenario": "egress_alternate_model_endpoints_denied",
                "host": alternate,
                "port": 443,
                "fallback_addresses": _observed_addresses(alternate),
            }
        )
    for external in (host, *ALTERNATE_MODEL_HOSTS[provider]):
        targets.append(
            {"scenario": "egress_runtime_dns_internal_only", "host": external, "port": 443, "resolve_only": True}
        )
    targets.extend(
        [
            {"scenario": "egress_internal_dns_resolved", "host": GATEWAY, "port": SERVICE_PORT, "resolve_only": True},
            {"scenario": "egress_gateway_path_observed", "host": GATEWAY, "port": SERVICE_PORT},
            {"scenario": "egress_knowledge_path_observed", "host": KNOWLEDGE, "port": SERVICE_PORT},
        ]
    )
    return targets


def _proxy_targets(cluster: QualificationCluster) -> list[dict[str, Any]]:
    host = PROVIDER_HOSTS[cluster.provider]
    common: dict[str, Any] = {
        "scenario": "egress_gateway_not_a_forward_proxy",
        "host": GATEWAY,
        "port": SERVICE_PORT,
        "tls": True,
        "client_identity": True,
        "sni": GATEWAY,
    }
    return [
        {**common, "request_form": "connect", "request": f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n"},
        {
            **common,
            "request_form": "absolute",
            "request": f"GET https://{host}/v1/models HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
        },
    ]


def _parse(raw: str) -> list[EgressAttempt]:
    return [EgressAttempt.model_validate_json(line) for line in raw.splitlines() if line.startswith("{")]


@pytest.fixture(scope="module")
def egress() -> tuple[QualificationCluster, list[EgressAttempt], str]:
    cluster = QualificationCluster.connect()
    pod = cluster.runtime_pod()
    raw = cluster.ephemeral_python(pod, PROBE, json.dumps(_direct_targets(cluster)))
    attempts = _parse(raw)
    if not attempts:
        pytest.fail("egress probe produced no observations")
    return cluster, attempts, cluster.keep_raw(f"egress-{cluster.provider}", raw)


def _scenario(attempts: list[EgressAttempt], scenario: str) -> list[EgressAttempt]:
    selected = [attempt for attempt in attempts if attempt.scenario == scenario]
    if not selected:
        pytest.fail(f"no probe attempt for {scenario}")
    return selected


def _detail(attempts: list[EgressAttempt]) -> str:
    return json.dumps([attempt.model_dump() for attempt in attempts])


@pytest.mark.parametrize(
    "scenario",
    [
        "egress_provider_hostname_denied",
        "egress_provider_ipv4_denied",
        "egress_provider_ipv6_denied",
        "egress_provider_redirect_hop_denied",
        "egress_alternate_model_endpoints_denied",
    ],
)
def test_direct_model_egress_is_denied(
    egress: tuple[QualificationCluster, list[EgressAttempt], str], scenario: str
) -> None:
    cluster, attempts, ref = egress
    selected = _scenario(attempts, scenario)
    outcome = direct_egress_outcome(selected)
    cluster.record("network", scenario, outcome, ref, _detail(selected))
    assert outcome == "satisfied", _detail(selected)


def test_runtime_dns_answers_cluster_names_only(egress: tuple[QualificationCluster, list[EgressAttempt], str]) -> None:
    cluster, attempts, ref = egress
    selected = _scenario(attempts, "egress_runtime_dns_internal_only")
    outcome = dns_internal_only_outcome(selected)
    cluster.record("network", "egress_runtime_dns_internal_only", outcome, ref, _detail(selected))
    assert outcome == "satisfied", _detail(selected)


@pytest.mark.parametrize(
    "scenario", ["egress_gateway_path_observed", "egress_knowledge_path_observed", "egress_internal_dns_resolved"]
)
def test_approved_paths_are_positively_observed(
    egress: tuple[QualificationCluster, list[EgressAttempt], str], scenario: str
) -> None:
    cluster, attempts, ref = egress
    selected = _scenario(attempts, scenario)
    if scenario == "egress_internal_dns_resolved":
        observed = all(attempt.resolved for attempt in selected)
    else:
        observed = all(attempt.tcp_connected for attempt in selected)
    cluster.record("network", scenario, "satisfied" if observed else "inconclusive", ref, _detail(selected))
    assert observed


def test_gateway_is_not_a_forward_proxy_for_an_authenticated_runtime() -> None:
    cluster = QualificationCluster.connect()
    pod = str(cluster.runtime_pod()["metadata"]["name"])
    completed = cluster.exec_python(pod, PROBE, json.dumps(_proxy_targets(cluster)))
    if completed.returncode != 0:
        pytest.fail(f"proxy probe failed to run: {completed.stderr.strip()[:200]}")
    attempts = _parse(completed.stdout)
    ref = cluster.keep_raw(f"forward-proxy-{cluster.provider}", completed.stdout)
    outcome = forward_proxy_outcome(attempts)
    cluster.record("network", "egress_gateway_not_a_forward_proxy", outcome, ref, _detail(attempts))
    assert outcome == "satisfied", _detail(attempts)
