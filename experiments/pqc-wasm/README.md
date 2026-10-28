# qbit PQC WASM B1 Spike

This folder is an isolated spike harness for qbit-wallet issue B1. It compiles
`Qbit-Org/qbit-libbitcoinpqc` to Emscripten WASM, runs the pinned upstream
golden vectors, benchmarks Node and a Chrome MV3 service worker, and writes raw
JSON under `.context/pqc-wasm-spike/`.

It is not the final `@qbit-oss/pqc` package.

## Prerequisites

- Upstream checkout at `.context/repos/libbitcoinpqc-qbit`
- Docker, unless `emcc` is installed locally
- Chrome for Testing or Chromium for the MV3 service-worker run

The default Docker toolchain is `emscripten/emsdk:4.0.10`.

Branded Google Chrome 137+ no longer honors `--load-extension` for automation.
Install Chrome for Testing locally when needed:

```sh
pnpm dlx @puppeteer/browsers install chrome@stable --path .context/browsers
```

## Build

```sh
experiments/pqc-wasm/scripts/build-wasm.sh all
```

Outputs:

- `.context/pqc-wasm-spike/dist/baseline/pqc.mjs`
- `.context/pqc-wasm-spike/dist/baseline/pqc.wasm`
- `.context/pqc-wasm-spike/dist/simd/pqc.mjs`
- `.context/pqc-wasm-spike/dist/simd/pqc.wasm`
- `.context/pqc-wasm-spike/dist/baseline-single/pqc.mjs`

## Run

```sh
node experiments/pqc-wasm/scripts/run-node-b1.mjs --variant baseline
node experiments/pqc-wasm/scripts/run-node-b1.mjs --variant simd

node experiments/pqc-wasm/scripts/run-mv3-b1.mjs --variant baseline
node experiments/pqc-wasm/scripts/run-mv3-b1.mjs --variant simd
```

Each command writes a JSON result file in `.context/pqc-wasm-spike/`.

The golden-vector extractor reads the pinned upstream Rust tests directly so B1
cannot drift from `tests/golden_vector_tests.rs`.

## SLH-DSA Golden Fixture

The PQC package conformance suite pins the SLH-DSA vectors as committed JSON:

- `experiments/pqc-wasm/fixtures/slh-dsa-golden.json`
- `experiments/pqc-wasm/fixtures/slh-dsa-golden.json.sha256`

The fixture is generated from
`Qbit-Org/qbit-libbitcoinpqc@d165da6a1535965d1f369000f396bd2de2db1d4d`
and records the upstream `tests/golden_vector_tests.rs` git blob and SHA-256.

Prepare the ignored upstream checkout when provenance verification is needed:

```sh
mkdir -p .context/repos
git clone https://github.com/Qbit-Org/qbit-libbitcoinpqc.git .context/repos/libbitcoinpqc-qbit
git -C .context/repos/libbitcoinpqc-qbit checkout d165da6a1535965d1f369000f396bd2de2db1d4d
```

If HTTPS access is unavailable, use the SSH clone URL instead:
`git@github.com:Qbit-Org/qbit-libbitcoinpqc.git`.

Regenerate the committed fixture and hash sidecar:

```sh
pnpm pqc:golden:write
```

Verify that the committed fixture is canonical, hash-pinned, and byte-for-byte
regenerated from the pinned upstream Rust source:

```sh
pnpm pqc:golden:verify
```

Run the offline fixture integrity test used by PQC CI, which does not require
the upstream checkout:

```sh
pnpm test:pqc-golden
```
