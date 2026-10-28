# B1 PQC WASM Spike Memo

Date: 2026-06-17

Decision: GO for B2 productionization, with one follow-up measurement on actual low-end hardware.

## Summary

`libbitcoinpqc-qbit` at `dde5aae2a245ee6321eb9552635c1d44f0a1204c` compiles to Emscripten WASM, passes the pinned upstream golden vectors byte-exact in Node and a Chrome MV3 service worker, and signs comfortably below the B1 target of about 2 seconds on this dev-class Mac. (`dde5aae2` is a commit of the private predecessor of the public [`Qbit-Org/qbit-libbitcoinpqc`](https://github.com/Qbit-Org/qbit-libbitcoinpqc); the packaged library and golden fixture now pin the public repository.)

Best observed path for B2: raw `.wasm` plus ES module loader, built with `-O3`; keep a `-msimd128` variant if target-browser support is acceptable. `SINGLE_FILE` works, but it is larger over gzip and is not needed for MV3.

Important issue-text correction: qbit-wallet issue #5 says the golden-vector seeds are `0x43`, `0xa4`, and `0xb0`. The pinned upstream Rust tests at the target SHA use `0x01`, `0x02`, and `0x03`; this spike uses the pinned upstream tests as source of truth.

## Environment

| Item | Value |
|---|---|
| Machine | Mac16,6, 38,654,705,664 bytes RAM |
| OS | macOS 26.3.1 (25D771280a) |
| Node | v25.8.1 |
| Browser for MV3 | Chrome for Testing 149.0.7827.155 |
| Emscripten | emcc 4.0.10, clang 21.0.0git |
| Emscripten image | `emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7` |

Branded Google Chrome was not used for automation because Chrome 137 removed automated `--load-extension` support for branded builds. Chrome for Testing worked.

## Artifacts

Checked-in harness:

- `experiments/pqc-wasm/src/pqc_wasm.c`
- `experiments/pqc-wasm/src/pqc-wrapper.mjs`
- `experiments/pqc-wasm/src/pqc-suite.mjs`
- `experiments/pqc-wasm/src/golden-vectors-from-rust.mjs`
- `experiments/pqc-wasm/mv3/background.mjs`
- `experiments/pqc-wasm/scripts/build-wasm.sh`
- `experiments/pqc-wasm/scripts/run-node-b1.mjs`
- `experiments/pqc-wasm/scripts/run-mv3-b1.mjs`

Scratch outputs:

- `.context/pqc-wasm-spike/dist/baseline/`
- `.context/pqc-wasm-spike/dist/simd/`
- `.context/pqc-wasm-spike/dist/baseline-single/`
- `.context/pqc-wasm-spike/node-baseline.json`
- `.context/pqc-wasm-spike/node-simd.json`
- `.context/pqc-wasm-spike/mv3-baseline.json`
- `.context/pqc-wasm-spike/mv3-simd.json`

## Source List

The WASM build uses only the production C inventory from upstream plus the B1 C shim:

```text
experiments/pqc-wasm/src/pqc_wasm.c
.context/repos/libbitcoinpqc-qbit/src/bitcoinpqc.c
.context/repos/libbitcoinpqc-qbit/src/slh_dsa/utils.c
.context/repos/libbitcoinpqc-qbit/src/slh_dsa/keygen.c
.context/repos/libbitcoinpqc-qbit/src/slh_dsa/validate.c
.context/repos/libbitcoinpqc-qbit/src/slh_dsa/sign.c
.context/repos/libbitcoinpqc-qbit/src/slh_dsa/verify.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/address.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/fors.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/hash_sha2.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/merkle.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/sha2.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/sha2_armv8_sha.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/sha2_x86_shani.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/sign.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/sign_stats.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/thash_sha2_simple.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/utils.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/utilsx1.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/wots.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/wotsx1.c
.context/repos/libbitcoinpqc-qbit/sphincsplus/ref/randombytes_custom.c
```

Not included: Dilithium/ML-DSA, Haraka, SHAKE, `fips202.c`, upstream test helpers, and AVX2 native sources.

## Build Flags

Common flags:

```text
-O3
-std=c99
-I .context/repos/libbitcoinpqc-qbit/include
-I .context/repos/libbitcoinpqc-qbit/sphincsplus/ref
-DPARAMS=sphincs-sha2-128s-bounded30
-DCUSTOM_RANDOMBYTES=1
-DSPX_PRODUCTION_BUILD=1
-DBITCOINPQC_FORSC_MAX_GRIND_ATTEMPTS=1835008
-DBITCOINPQC_WOTSC_MAX_COUNTER=65535
-fstack-protector-strong
-Wall
-Wextra
-Werror=implicit-function-declaration
--no-entry
-sMODULARIZE=1
-sEXPORT_ES6=1
-sENVIRONMENT=web,worker,node
-sALLOW_MEMORY_GROWTH=1
-sEXIT_RUNTIME=0
-sINCOMING_MODULE_JS_API=["locateFile","wasmBinary"]
-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]
-sEXPORTED_FUNCTIONS=[..._malloc,_free,_qbit_pqc_*]
```

SIMD adds:

```text
-msimd128
```

Single-file comparison adds:

```text
-sSINGLE_FILE=1
```

## Commands

```sh
docker pull emscripten/emsdk:4.0.10
pnpm dlx @puppeteer/browsers install chrome@stable --path .context/browsers

experiments/pqc-wasm/scripts/build-wasm.sh all

node experiments/pqc-wasm/scripts/run-node-b1.mjs --variant baseline --iterations 20 --warmup 2
node experiments/pqc-wasm/scripts/run-node-b1.mjs --variant simd --iterations 20 --warmup 2
node experiments/pqc-wasm/scripts/run-mv3-b1.mjs --variant baseline --iterations 20 --warmup 2
node experiments/pqc-wasm/scripts/run-mv3-b1.mjs --variant simd --iterations 20 --warmup 2
```

## Correctness

Passed in Node and Chrome MV3 service worker:

- Three upstream golden-vector cases from `tests/golden_vector_tests.rs`
- Byte-exact public key, secret key, and signature
- Valid signature verifies
- Bit-flipped signature fails verification
- Truncated signature fails verification
- Malformed secret key fails `secretKeyValidate`

Pinned-vector cases used:

| Case | Entropy seed | Message |
|---|---:|---|
| `golden_vector_short_message` | `0x01` | `golden-short` |
| `golden_vector_empty_message` | `0x02` | empty |
| `golden_vector_1kb_message` | `0x03` | `deterministicBytes(1024, 0x03)` |

## Benchmarks

Each row is 20 measured iterations after 2 warmup iterations.

| Environment | Variant | Operation | Median ms | P95 ms |
|---|---|---|---:|---:|
| Node | baseline | keygen | 40.56 | 41.01 |
| Node | baseline | sign short message | 430.76 | 466.61 |
| Node | baseline | sign 32-byte message | 433.50 | 460.33 |
| Node | baseline | verify 32-byte message | 1.96 | 2.06 |
| Node | SIMD | keygen | 40.56 | 41.44 |
| Node | SIMD | sign short message | 429.35 | 460.04 |
| Node | SIMD | sign 32-byte message | 431.09 | 459.92 |
| Node | SIMD | verify 32-byte message | 1.95 | 1.98 |
| Chrome MV3 service worker | baseline | keygen | 40.40 | 41.20 |
| Chrome MV3 service worker | baseline | sign short message | 439.20 | 467.10 |
| Chrome MV3 service worker | baseline | sign 32-byte message | 439.10 | 479.00 |
| Chrome MV3 service worker | baseline | verify 32-byte message | 2.00 | 2.10 |
| Chrome MV3 service worker | SIMD | keygen | 40.40 | 42.70 |
| Chrome MV3 service worker | SIMD | sign short message | 427.30 | 451.30 |
| Chrome MV3 service worker | SIMD | sign 32-byte message | 432.10 | 467.90 |
| Chrome MV3 service worker | SIMD | verify 32-byte message | 2.30 | 2.40 |

Interpretation: both baseline and SIMD are comfortably below the 2 second signing target on this machine. SIMD helps slightly in MV3 and is roughly neutral in Node.

## Size and Memory

| Artifact | Raw bytes | Gzip bytes |
|---|---:|---:|
| baseline `pqc.wasm` | 48,184 | 17,006 |
| baseline `pqc.mjs` | 7,461 | 2,554 |
| SIMD `pqc.wasm` | 47,402 | 16,473 |
| SIMD `pqc.mjs` | 7,461 | 2,554 |
| baseline single-file `pqc.mjs` | 71,812 | 25,827 |

Raw `.wasm` plus loader is smaller than `SINGLE_FILE`:

- baseline raw pair gzip total: 19,560 bytes
- baseline single-file gzip: 25,827 bytes

WASM heap:

| Environment | Variant | Heap after load | Heap after correctness | Heap after benchmarks |
|---|---|---:|---:|---:|
| Node | baseline | 16,908,288 | 16,908,288 | 16,908,288 |
| Node | SIMD | 16,908,288 | 16,908,288 | 16,908,288 |
| Chrome MV3 service worker | baseline | 16,908,288 | 16,908,288 | 16,908,288 |
| Chrome MV3 service worker | SIMD | 16,908,288 | 16,908,288 | 16,908,288 |

No memory growth was observed during the measured runs. MV3 only exposed the WASM heap size through this harness; browser service-worker JS heap numbers were not available from `performance.memory`.

## MV3 Notes

The minimal extension uses:

```json
{
  "background": {
    "service_worker": "background.mjs",
    "type": "module"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

`wasm-unsafe-eval` is required for extension pages/workers to use WebAssembly. The local wallet already has this in `apps/extension/build/_raw/manifest/_base_v3.json`, and webpack already enables async WebAssembly.

Chrome extension service workers support static module imports when the manifest background worker has `"type": "module"`, but dynamic `import()` is not supported. The B1 harness therefore uses static imports.

Automation note: use Chrome for Testing or Chromium in CI. Branded Google Chrome 137+ does not honor automated unpacked-extension loading.

## Security Notes

The JS glue does exactly what B2 will need to do:

1. Allocate WASM heap memory with `_malloc`.
2. Copy entropy, secret key, message, and signature bytes into `HEAPU8`.
3. Call the exported C shim.
4. Copy public outputs back to JS-owned `Uint8Array`s.
5. Zero entropy and secret-key scratch ranges in WASM memory before `_free`.

This is normal for Emscripten/WASM crypto bindings, but it is not hardware-wallet-style isolation. Any code running with the same extension privileges and access to the module can read JS-owned key arrays or WASM linear memory while data is live. Zeroing reduces post-use residue; it does not defend against active compromise, malicious dependencies, XSS in extension contexts, or DevTools-level inspection.

## B4/B2 Closeout

The B4 SLH-DSA golden-vector fixture is checked in at `experiments/pqc-wasm/fixtures/slh-dsa-golden.json`, with a SHA-256 sidecar at `experiments/pqc-wasm/fixtures/slh-dsa-golden.json.sha256`. Use `pnpm pqc:golden:verify` to prove the fixture is canonical, hash-pinned, and regenerated byte-for-byte from `Qbit-Org/qbit-libbitcoinpqc@d165da6a1535965d1f369000f396bd2de2db1d4d`.

Precedent: Emscripten exposes WASM memory through typed-array heap views such as `HEAPU8`, and established browser crypto bindings such as libsodium.js use Emscripten/WASM with explicit secure zeroization APIs. The qbit wrapper should continue this pattern and keep secret-bearing buffers short-lived.

Issue #11 B2 package closeout status:

- Done: `@qbit/pqc` owns the pinned C inventory, C shim, reproducible baseline WASM artifacts, TypeScript wrapper, golden-vector tests, MV3 runtime smoke, and extension build/package smoke.
- Done: PQC CI runs the committed SLH-DSA fixture verifier, the offline golden fixture test, package build/test/typecheck, WASM hash/repro checks, Chrome for Testing MV3 smoke, and the extension import/package smoke.
- Deferred: wallet/keyring integration, low-end hardware timing, long-running MV3 service-worker lifecycle soak, and side-channel/constant-time audit remain explicit follow-ups.

Recommended wrapper hardening retained for wallet integration:

- Keep the wrapper API binary-only (`Uint8Array`), with no secret-key logging or hex dumps.
- Zero WASM scratch buffers for entropy and secret keys in `finally` blocks.
- Avoid returning views into WASM memory; copy outputs into independent arrays.
- Treat returned secret-key arrays as live key material; wipe or store them through the wallet keyring policy.
- Keep WASM packaged locally under MV3 CSP; do not load remote code.
- Add tests that fail if secret-key and entropy scratch wipes are removed.

## Known Limitations

- No separate low-end hardware was available in this workspace. The 2 second target has wide margin on the dev-class Mac, but B2 should rerun this harness on the lowest supported user device.
- No long-running service-worker lifecycle soak was performed.
- No wallet keyring, provider, UX, or protocol integration was attempted.
- No side-channel or constant-time audit was performed.
- No upstream changes were made.
- The upstream `sha2_armv8_sha.c` file emits two unused-function warnings under wasm; the build succeeds and keeps the source list aligned with upstream production CMake.

## B2 Guidance

Proceed with wallet/keyring integration only after the package layer remains
green in PQC CI. Do not wire PQC into wallet flows as part of the package
closeout.

The B2 package layer uses this source list and flags. It keeps raw `.wasm` plus
an ES module loader for size and MV3 behavior. SIMD remains a later
browser-matrix decision; the checked-in baseline build is the CI source of
truth.

Remaining production integration follow-ups:

- Rerun timing on the lowest supported user device before UX commitments.
- Add a long-running service-worker lifecycle soak before relying on PQC in extension background flows.
- Complete a side-channel/constant-time review appropriate to the signing threat model.
- Integrate wallet/keyring storage and signing policy in a separate PR.

Fallback ranking if low-end hardware misses the target:

1. SIMD default build, baseline fallback.
2. Move signing off the hot UI path through extension worker/offscreen execution and progress UI.
3. Explore upstream SHA-256/WOTS/FORS optimizations.
4. Native messaging companion only as a last resort; it adds installation and trust complexity.

## References

- Upstream repo: <https://github.com/Qbit-Org/qbit-libbitcoinpqc>
- qbit-wallet issue #5
- Chrome CSP docs: <https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy>
- Chrome extension service-worker docs: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics>
- Chrome 137 `--load-extension` change: <https://developer.chrome.com/blog/extension-news-june-2025>
- Emscripten memory docs: <https://emscripten.org/docs/api_reference/preamble.js.html>
- libsodium secure memory docs: <https://libsodium.gitbook.io/doc/memory_management>
