# syntax=docker/dockerfile:1.7
# ESP Grok Build Shared Harness Instance (ShaHarIns) runtime image. Candidate only; DA-01 is pending.
#
# One container holds the ESP runtime entry and the exact Grok Build it supervises as its one main
# `grok agent --no-leader stdio` process. Build from the repository root with two named build contexts.
# The build downloads no harness binary and no Python package, and fails closed on any digest mismatch:
#
#   docker build -f infra/runtime/grok/Dockerfile \
#     --build-context grok-native=<directory holding grok-1.0.46-linux-x86_64, named `grok`> \
#     --build-context wheels=<directory holding the two requirement files and the wheels they list> .
#
#   requirements.txt: uv export --frozen --no-dev --no-emit-workspace --package esp-provider-xai
#   workspace-requirements.txt: one `<name>==<version> --hash=sha256:<digest>` line for each of the
#           three workspace wheels below, written when they are built (for example with `pip hash`),
#           so the image installs exactly the wheels whose digests the build recorded.
#   wheels: the hash-listed third-party wheels plus `uv build --wheel` of esp-contracts,
#           esp-provider-shared and esp-provider-xai from the same commit.
#
# Engineering choices (any change requires requalification): Ubuntu 24.04 pinned by digest, with an
# apt snapshot pinned for Python 3.12; the harness pinned by the sha256 of its native binary, the same
# digest GROK_BUILD names in esp_provider_xai.grok_build_adapter. The image has no shell binary
# (Python and Perl remain; see the last RUN), runs as a fixed non-root user, carries no credential and
# expects a read-only root file system. The build's self-updater is disabled; the configuration is
# staged into GROK_HOME by the supervised entry.

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS harness
COPY --from=grok-native grok /staging/grok
RUN echo "41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc  /staging/grok" | sha256sum --check --strict \
    && chmod 0555 /staging/grok

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
    && /opt/esp/venv/bin/pip install --no-index --find-links=/tmp/wheels --require-hashes --no-deps -r /tmp/wheels/workspace-requirements.txt \
    && /opt/esp/venv/bin/python -m pip uninstall --yes pip \
    && rm -rf /tmp/wheels
COPY --from=harness /staging/grok /opt/esp/bin/grok
COPY infra/runtime/grok/config.toml /etc/esp/grok/config.toml
COPY infra/runtime/tool-policy.json /etc/esp/tool-policy.json
# Last: remove every shell binary, in exec form because no shell is left. This is defence in depth,
# not interpreter removal: python3 (the runtime entry) and perl-base (essential in the base) remain.
# Keeping tools from running commands rests on the tool policy, whose enforcement the live checks in
# tests/qualification/test_tool_policy.py must still demonstrate.
RUN ["/usr/bin/rm", "-f", "/bin/sh", "/bin/bash", "/bin/dash", "/bin/rbash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash", "/usr/bin/rbash"]

LABEL org.opencontainers.image.title="esp-grok-runtime" \
      esp.openedge.dev/harness-build="grok 1.0.46 (2765805b9442) sha256:41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc" \
      esp.openedge.dev/qualification="pending"
ENV ESP_NATIVE_ROOT=/var/lib/esp/native \
    HOME=/var/lib/esp/native/home \
    GROK_HOME=/var/lib/esp/native/grok \
    GROK_DISABLE_AUTOUPDATER=1 \
    TMPDIR=/var/lib/esp/native/tmp \
    ESP_HARNESS_BINARY=/opt/esp/bin/grok \
    ESP_HARNESS_CONFIG=/etc/esp/grok/config.toml \
    ESP_TOOL_POLICY=/etc/esp/tool-policy.json
USER 65532:65532
ENTRYPOINT ["/opt/esp/venv/bin/python", "-m", "esp_provider_shared.runtime_main", "--harness", "grok-build"]
