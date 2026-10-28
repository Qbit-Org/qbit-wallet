FROM debian:bookworm-slim AS base

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl librocksdb-dev && \
    rm -rf /var/lib/apt/lists/*

FROM base AS build

ARG ELECTRS_QBIT_REPO=Qbit-Org/qbit-electrs
ARG ELECTRS_QBIT_REF=5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2

RUN apt-get update && \
    apt-get install -y --no-install-recommends clang cmake g++ git make pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/rust
ENV CARGO_HOME=/cargo
ENV PATH=/cargo/bin:/rust/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

WORKDIR /src

# The published image is public, so it may only be built from the public
# upstream source, cloned without credentials.
RUN set -eu; \
    if [ "$ELECTRS_QBIT_REPO" != "Qbit-Org/qbit-electrs" ]; then \
      echo "ELECTRS_QBIT_REPO must be Qbit-Org/qbit-electrs" >&2; \
      exit 1; \
    fi; \
    if ! printf '%s\n' "$ELECTRS_QBIT_REF" | grep -Eq '^[0-9a-f]{40}$'; then \
      echo "ELECTRS_QBIT_REF must be a full lowercase commit ID" >&2; \
      exit 1; \
    fi; \
    git clone --no-checkout "https://github.com/${ELECTRS_QBIT_REPO}.git" electrs-qbit; \
    cd electrs-qbit; \
    git checkout "$ELECTRS_QBIT_REF"; \
    install -D -m 0644 LICENSE /usr/local/share/doc/electrs/LICENSE

RUN --mount=type=cache,target=/cargo/registry \
    --mount=type=cache,target=/src/electrs-qbit/target \
    set -eu; \
    cd /src/electrs-qbit; \
    cargo build --release --bin electrs; \
    cp /src/electrs-qbit/target/release/electrs /usr/local/bin/electrs

FROM base

LABEL org.opencontainers.image.source="https://github.com/Qbit-Org/qbit-wallet" \
      org.opencontainers.image.description="electrs built from Qbit-Org/qbit-electrs for the qbit-wallet regtest harness" \
      org.opencontainers.image.licenses="MIT"

COPY --from=build /usr/local/bin/electrs /usr/local/bin/electrs
COPY --from=build /usr/local/share/doc/electrs/LICENSE /usr/local/share/doc/electrs/LICENSE

EXPOSE 3002 60401 24224
ENTRYPOINT ["electrs"]
