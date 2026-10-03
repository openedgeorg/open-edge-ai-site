# syntax=docker/dockerfile:1.7
# ESP Codex Shared Harness Instance (ShaHarIns) runtime image. Candidate only; DA-01 is pending.
#
# One container holds the ESP runtime entry and the exact Codex build it supervises as its one main
# process. Build from the repository root with two named build contexts. The build downloads no
# harness binary and no Python package, and fails closed on any digest mismatch:
#
#   docker build -f infra/runtime/codex/Dockerfile \
#     --build-context codex-native=<directory holding the vendored native binary, named `codex`> \
#     --build-context wheels=<directory holding requirements.txt and the wheels it lists> .
#
#   requirements.txt: uv export --frozen --no-dev --no-emit-workspace --package esp-provider-openai
#   wheels: the hash-listed third-party wheels plus `uv build --wheel` of esp-contracts,
#           esp-provider-shared and esp-provider-openai from the same commit.
#
# Engineering choices (any change requires requalification): Ubuntu 24.04 pinned by digest, with an
# apt snapshot pinned for Python 3.12; the harness pinned by the sha256 of its native binary, the same
# digest CODEX_BUILD names in esp_provider_openai.codex_adapter. The image has no shell, runs as a
# fixed non-root user, carries no credential and expects a read-only root file system.

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS harness
COPY --from=codex-native codex /staging/codex
RUN echo "8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479  /staging/codex" | sha256sum --check --strict \
    && chmod 0555 /staging/codex

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update --snapshot 20260622T000000Z \
    && apt-get install --yes --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=wheels / /tmp/wheels/
RUN python3 -m venv /opt/esp/venv \
    && /opt/esp/venv/bin/pip install --no-index --find-links=/tmp/wheels --require-hashes -r /tmp/wheels/requirements.txt \
    && /opt/esp/venv/bin/pip install --no-index --find-links=/tmp/wheels --no-deps esp-contracts esp-provider-shared esp-provider-openai \
    && /opt/esp/venv/bin/python -m pip uninstall --yes pip \
    && rm -rf /tmp/wheels
COPY --from=harness /staging/codex /opt/esp/bin/codex
COPY infra/runtime/codex/config.toml /etc/esp/codex/config.toml
COPY infra/runtime/tool-policy.json /etc/esp/tool-policy.json
# Last: remove every shell so no tool can start an arbitrary command interpreter.
RUN ["/usr/bin/rm", "-f", "/bin/sh", "/bin/bash", "/bin/dash", "/bin/rbash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash", "/usr/bin/rbash"]

LABEL org.opencontainers.image.title="esp-codex-runtime" \
      esp.openedge.dev/harness-build="codex-cli 0.159.3 sha256:8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479" \
      esp.openedge.dev/qualification="pending"
ENV ESP_NATIVE_ROOT=/var/lib/esp/native \
    HOME=/var/lib/esp/native/home \
    CODEX_HOME=/var/lib/esp/native/codex \
    TMPDIR=/var/lib/esp/native/tmp \
    ESP_HARNESS_BINARY=/opt/esp/bin/codex \
    ESP_HARNESS_CONFIG=/etc/esp/codex/config.toml \
    ESP_TOOL_POLICY=/etc/esp/tool-policy.json
USER 65532:65532
ENTRYPOINT ["/opt/esp/venv/bin/python", "-m", "esp_provider_shared.runtime_main", "--harness", "codex"]
