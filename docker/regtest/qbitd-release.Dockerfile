# Runtime image for qbitd, installed from a pinned Qbit-Org release.
#
# Qbit-Org publishes signed release tags and archive checksum manifests, so we
# fetch and authenticate the release tarball instead of compiling Qbit Core
# from source. This turns a ~30-45 min C++ build into a
# few-second download and needs no clone token because the assets are public.
FROM debian:bookworm-slim

# QBIT_RELEASE is the Qbit Core release tag. The archive digest arguments bind
# the downloaded binaries to scripts/conformance/core-pin.json instead of
# trusting a mutable release asset or image tag.
ARG QBIT_REPO=Qbit-Org/qbit
ARG QBIT_RELEASE=v1.0.0
ARG QBIT_SOURCE_COMMIT=7ebcddb622d6e639041f005a189b048ec2a221fe
ARG QBIT_ARCHIVE_SHA256_AMD64=ae121af03263b55d530e3f3e8719a71362d0950cba82f54a2bc2d6c437a029b5
ARG QBIT_ARCHIVE_SHA256_ARM64=a0242e5941eec64070f386e80c848220e2ec2292984a9b2ab1fd93f57436b31d
# Set automatically by BuildKit/buildx: amd64 on CI runners, arm64 on Apple
# Silicon. Selects the matching release tarball.
ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/${QBIT_REPO}" \
      org.opencontainers.image.version="${QBIT_RELEASE}" \
      org.opencontainers.image.revision="${QBIT_SOURCE_COMMIT}"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libsqlite3-0 \
      libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    printf '%s\n' "${QBIT_SOURCE_COMMIT}" | grep -Eq '^[0-9a-f]{40}$' || { \
      echo "a signed release source commit is required" >&2; \
      exit 1; \
    }; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch="x86_64-linux-gnu"; expected_sha256="${QBIT_ARCHIVE_SHA256_AMD64}" ;; \
      arm64) arch="aarch64-linux-gnu"; expected_sha256="${QBIT_ARCHIVE_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH='${TARGETARCH:-}'" >&2; exit 1 ;; \
    esac; \
    printf '%s\n' "${expected_sha256}" | grep -Eq '^[0-9a-f]{64}$' || { \
      echo "a committed 64-character lowercase SHA-256 is required for ${TARGETARCH:-amd64}" >&2; \
      exit 1; \
    }; \
    version="${QBIT_RELEASE#v}"; \
    tarball="qbit-${version}-${arch}.tar.gz"; \
    base="https://github.com/${QBIT_REPO}/releases/download/${QBIT_RELEASE}"; \
    cd /tmp; \
    curl -fsSLO "${base}/${tarball}"; \
    curl -fsSL "${base}/SHA256SUMS" -o SHA256SUMS; \
    sha256sum --ignore-missing -c SHA256SUMS; \
    printf '%s  %s\n' "${expected_sha256}" "${tarball}" | sha256sum -c -; \
    tar -xzf "${tarball}"; \
    install -m 0755 "qbit-${version}/bin/qbitd" /usr/local/bin/qbitd; \
    install -m 0755 "qbit-${version}/bin/qbit-cli" /usr/local/bin/qbit-cli; \
    rm -rf "/tmp/${tarball}" "/tmp/qbit-${version}" /tmp/SHA256SUMS; \
    qbitd --version; \
    qbit-cli --version

EXPOSE 18452 18460
ENTRYPOINT ["qbitd"]
