#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
cd "$ROOT"

UPSTREAM=${UPSTREAM:-"$ROOT/.context/repos/libbitcoinpqc-qbit"}
OUT_ROOT=${OUT_ROOT:-".context/pqc-wasm-spike/dist"}
EMSDK_IMAGE=${EMSDK_IMAGE:-"emscripten/emsdk:4.0.10"}
VARIANT=${1:-all}

if [[ "$OUT_ROOT" == "$ROOT/"* ]]; then
  OUT_ROOT=${OUT_ROOT#"$ROOT/"}
fi

if [[ ! -d "$UPSTREAM" ]]; then
  echo "missing upstream checkout: $UPSTREAM" >&2
  exit 1
fi

mkdir -p "$OUT_ROOT"

if command -v emcc >/dev/null 2>&1; then
  EMCC=(emcc)
else
  EMCC=(docker run --rm --platform linux/amd64 -u "$(id -u):$(id -g)" -v "$ROOT:/src" -w /src "$EMSDK_IMAGE" emcc)
fi

SOURCES=(
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
)

COMMON_FLAGS=(
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
  '-sINCOMING_MODULE_JS_API=["locateFile","wasmBinary"]'
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]'
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_qbit_pqc_public_key_size","_qbit_pqc_secret_key_size","_qbit_pqc_signature_size","_qbit_pqc_keygen_entropy_min_size","_qbit_pqc_keygen","_qbit_pqc_secret_key_validate","_qbit_pqc_sign","_qbit_pqc_sign_with_stats","_qbit_pqc_verify"]'
)

build_one() {
  local variant=$1
  shift
  local out_dir="$OUT_ROOT/$variant"
  mkdir -p "$out_dir"
  echo "building $variant -> $out_dir"
  "${EMCC[@]}" "${COMMON_FLAGS[@]}" "$@" "${SOURCES[@]}" -o "$out_dir/pqc.mjs"
}

case "$VARIANT" in
  baseline)
    build_one baseline
    ;;
  simd)
    build_one simd -msimd128
    ;;
  single)
    build_one baseline-single -sSINGLE_FILE=1
    ;;
  all)
    build_one baseline
    build_one simd -msimd128
    build_one baseline-single -sSINGLE_FILE=1
    ;;
  *)
    echo "usage: $0 [baseline|simd|single|all]" >&2
    exit 1
    ;;
esac
