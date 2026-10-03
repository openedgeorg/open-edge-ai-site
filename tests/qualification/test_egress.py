"""Live egress enforcement from the actual runtime pod network (run only via scripts/qualify.py).

The probe runs in an ephemeral container attached to the running runtime pod, so it shares that pod's
network namespace and therefore its NetworkPolicy. Only a connection that never completes counts as
denied; any completed TCP connection or HTTP status (including a provider `401`) is a bypass.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from scripts.qualify import EgressAttempt, classify_egress_attempt
from tests.support.qualification_cluster import QualificationCluster

PROVIDER_HOSTS = {"openai": "api.openai.com", "xai": "api.x.ai"}
ALTERNATE_MODEL_HOSTS = {
    "openai": ("api.x.ai", "chatgpt.com", "api.anthropic.com", "generativelanguage.googleapis.com"),
    "xai": ("api.openai.com", "grok.com", "api.anthropic.com", "generativelanguage.googleapis.com"),
}
GATEWAY = "esp-inference-gateway.esp-qualification.svc.cluster.local"
KNOWLEDGE = "esp-knowledge.esp-qualification.svc.cluster.local"
SERVICE_PORT = 8443

# Runs inside the runtime image. Standard library only; never sends a credential.
PROBE = r"""
import errno, json, socket, ssl, sys
NAMES = {errno.ECONNREFUSED: "connection_refused", errno.ECONNRESET: "connection_reset",
         errno.EHOSTUNREACH: "host_unreachable", errno.ENETUNREACH: "network_unreachable",
         errno.ETIMEDOUT: "timeout", errno.EACCES: "permission_denied", errno.EPERM: "permission_denied"}
for target in json.loads(sys.argv[1]):
    out = {"scenario": target["scenario"], "target": "%s:%d" % (target["host"], target["port"]),
           "resolved": False, "tcp_connected": False, "tls_established": None, "http_status": None, "error": None}
    family = {"ipv4": socket.AF_INET, "ipv6": socket.AF_INET6}.get(target.get("family"), socket.AF_UNSPEC)
    try:
        infos = socket.getaddrinfo(target["host"], target["port"], family, socket.SOCK_STREAM)
        out["resolved"] = True
    except socket.gaierror:
        out["error"] = "name_unresolved"
        print(json.dumps(out)); continue
    if target.get("resolve_only"):
        print(json.dumps(out)); continue
    sock = socket.socket(infos[0][0], socket.SOCK_STREAM)
    sock.settimeout(target.get("timeout", 5.0))
    try:
        sock.connect(infos[0][4])
        out["tcp_connected"] = True
        if target.get("tls"):
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=target.get("sni") or target["host"])
            out["tls_established"] = True
        if target.get("request"):
            sock.sendall(target["request"].encode())
            head = sock.recv(64).decode("latin-1")
            if head.startswith("HTTP/"):
                out["http_status"] = int(head.split()[1])
    except socket.timeout:
        if not out["tcp_connected"]:
            out["error"] = "timeout"
    except ssl.SSLError:
        out["error"] = "tls_refused"
    except OSError as exc:
        out["error"] = NAMES.get(exc.errno, "os_error_%s" % exc.errno)
    finally:
        sock.close()
    print(json.dumps(out))
"""


def _targets(cluster: QualificationCluster) -> list[dict[str, Any]]:
    provider = cluster.provider
    host = PROVIDER_HOSTS[provider]
    addresses = cluster.environment.provider_addresses[provider]
    https = f"GET /v1/models HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    targets: list[dict[str, Any]] = [
        {"scenario": "egress_provider_hostname_denied", "host": host, "port": 443, "tls": True, "request": https},
        {"scenario": "egress_provider_redirect_hop_denied", "host": host, "port": 80, "request": https},
    ]
    for address in addresses.ipv4:
        targets.append({"scenario": "egress_provider_ipv4_denied", "host": address, "port": 443, "family": "ipv4"})
    for address in addresses.ipv6:
        targets.append({"scenario": "egress_provider_ipv6_denied", "host": address, "port": 443, "family": "ipv6"})
    for alternate in ALTERNATE_MODEL_HOSTS[provider]:
        targets.append({"scenario": "egress_alternate_model_endpoints_denied", "host": alternate, "port": 443})
    targets.extend(
        [
            {"scenario": "egress_internal_dns_resolved", "host": GATEWAY, "port": SERVICE_PORT, "resolve_only": True},
            {"scenario": "egress_gateway_path_observed", "host": GATEWAY, "port": SERVICE_PORT},
            {"scenario": "egress_knowledge_path_observed", "host": KNOWLEDGE, "port": SERVICE_PORT},
            {
                "scenario": "egress_gateway_not_a_forward_proxy",
                "host": GATEWAY,
                "port": SERVICE_PORT,
                "tls": True,
                "request": f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n",
            },
            {
                "scenario": "egress_gateway_not_a_forward_proxy",
                "host": GATEWAY,
                "port": SERVICE_PORT,
                "tls": True,
                "request": f"GET https://{host}/v1/models HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
            },
        ]
    )
    return targets


@pytest.fixture(scope="module")
def egress() -> tuple[QualificationCluster, list[EgressAttempt], str]:
    cluster = QualificationCluster.connect()
    pod = cluster.runtime_pod()
    raw = cluster.ephemeral_python(pod, PROBE, json.dumps(_targets(cluster)))
    attempts = [EgressAttempt.model_validate_json(line) for line in raw.splitlines() if line.startswith("{")]
    if not attempts:
        pytest.fail("egress probe produced no observations")
    return cluster, attempts, cluster.keep_raw(f"egress-{cluster.provider}", raw)


def _scenario(attempts: list[EgressAttempt], scenario: str) -> list[EgressAttempt]:
    selected = [attempt for attempt in attempts if attempt.scenario == scenario]
    if not selected:
        pytest.fail(f"no probe attempt for {scenario}")
    return selected


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
    classes = [classify_egress_attempt(attempt) for attempt in _scenario(attempts, scenario)]
    detail = json.dumps([attempt.model_dump() for attempt in _scenario(attempts, scenario)])
    if "reached" in classes:
        cluster.record("network", scenario, "violated", ref, detail)
    elif all(item == "denied" for item in classes):
        cluster.record("network", scenario, "satisfied", ref, detail)
    else:
        cluster.record("network", scenario, "inconclusive", ref, detail)
    assert all(item == "denied" for item in classes), detail


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
    cluster.record(
        "network",
        scenario,
        "satisfied" if observed else "inconclusive",
        ref,
        json.dumps([a.model_dump() for a in selected]),
    )
    assert observed


def test_gateway_is_not_a_forward_proxy(egress: tuple[QualificationCluster, list[EgressAttempt], str]) -> None:
    cluster, attempts, ref = egress
    selected = _scenario(attempts, "egress_gateway_not_a_forward_proxy")
    detail = json.dumps([attempt.model_dump() for attempt in selected])
    proxied = [attempt for attempt in selected if attempt.http_status is not None and 200 <= attempt.http_status < 300]
    refused = [
        attempt
        for attempt in selected
        if attempt.tcp_connected and (attempt.http_status is not None and attempt.http_status >= 400 or attempt.error)
    ]
    if proxied:
        cluster.record("network", "egress_gateway_not_a_forward_proxy", "violated", ref, detail)
    elif len(refused) == len(selected):
        cluster.record("network", "egress_gateway_not_a_forward_proxy", "satisfied", ref, detail)
    else:
        cluster.record("network", "egress_gateway_not_a_forward_proxy", "inconclusive", ref, detail)
    assert not proxied and len(refused) == len(selected), detail
