#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
UPSTREAM=${UPSTREAM:-"$ROOT/.context/repos/libbitcoinpqc-qbit"}
REPO_URL=${LIBBITCOINPQC_QBIT_REPO_URL:-"https://github.com/Qbit-Org/qbit-libbitcoinpqc.git"}
PINNED_COMMIT="d165da6a1535965d1f369000f396bd2de2db1d4d"

mkdir -p "$(dirname -- "$UPSTREAM")"

if [ ! -d "$UPSTREAM/.git" ]; then
  git clone --filter=blob:none --no-checkout "$REPO_URL" "$UPSTREAM"
fi

if ! git -C "$UPSTREAM" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout: $UPSTREAM" >&2
  exit 1
fi

git -C "$UPSTREAM" remote set-url origin "$REPO_URL"

if ! git -C "$UPSTREAM" cat-file -e "$PINNED_COMMIT^{commit}" 2>/dev/null; then
  git -C "$UPSTREAM" fetch --depth=1 origin "$PINNED_COMMIT"
fi

git -C "$UPSTREAM" checkout --detach "$PINNED_COMMIT"
echo "prepared $REPO_URL at $PINNED_COMMIT in $UPSTREAM"
