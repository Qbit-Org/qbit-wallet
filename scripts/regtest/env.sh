#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGTEST_DIR="$ROOT_DIR/scripts/regtest"
COMPOSE_FILE="${QBIT_REGTEST_COMPOSE_FILE:-$ROOT_DIR/docker-compose.regtest.yml}"
QBIT_CLI_BIN="${QBIT_REGTEST_CLI:-}"
QBIT_RPC_USER="${QBIT_RPC_USER:-qbit}"
QBIT_RPC_PASSWORD="${QBIT_RPC_PASSWORD:-qbit}"
QBIT_RPC_PORT="${QBIT_REGTEST_RPC_PORT:-18452}"
QBIT_RPC_HOST="${QBIT_REGTEST_RPC_HOST:-127.0.0.1}"
QBIT_FUNDING_WALLET="${QBIT_FUNDING_WALLET:-qbit-funding}"
QBIT_COINBASE_MATURITY="${QBIT_REGTEST_COINBASE_MATURITY:-1000}"
QBIT_ELECTRS_HTTP_URL="${QBIT_REGTEST_ELECTRS_HTTP_URL:-http://127.0.0.1:3002}"
QBIT_DOCKER_SERVICE="${QBIT_REGTEST_DOCKER_SERVICE:-qbitd}"
QBIT_ELECTRS_DOCKER_SERVICE="${QBIT_REGTEST_ELECTRS_DOCKER_SERVICE:-electrs-qbit}"
QBIT_CONTAINER_RPC_HOST="${QBIT_REGTEST_CONTAINER_RPC_HOST:-127.0.0.1}"
QBIT_CONTAINER_RPC_PORT="${QBIT_REGTEST_CONTAINER_RPC_PORT:-18452}"

die() {
  echo "$*" >&2
  exit 1
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    echo "docker compose or docker-compose is required" >&2
    return 127
  fi
}

http_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url"
  elif command -v python3 >/dev/null 2>&1; then
    HTTP_URL="$url" python3 - <<'PY'
import os
import sys
import urllib.request

try:
    with urllib.request.urlopen(os.environ["HTTP_URL"], timeout=10) as response:
        sys.stdout.buffer.write(response.read())
except Exception:
    sys.exit(1)
PY
  elif command -v node >/dev/null 2>&1; then
    HTTP_URL="$url" node - <<'JS'
fetch(process.env.HTTP_URL)
  .then(async response => {
    if (!response.ok) {
      process.exit(1)
    }
    process.stdout.write(await response.text())
  })
  .catch(() => process.exit(1))
JS
  else
    echo "curl, python3, or node is required for HTTP readiness checks" >&2
    return 127
  fi
}

http_post_json_basic_auth() {
  local url="$1"
  local body="$2"
  local user="$3"
  local password="$4"
  if command -v curl >/dev/null 2>&1; then
    curl --user "$user:$password" \
      --data-binary "$body" \
      -H "content-type: text/plain;" \
      -fsS "$url"
  elif command -v python3 >/dev/null 2>&1; then
    HTTP_URL="$url" HTTP_BODY="$body" HTTP_USER="$user" HTTP_PASSWORD="$password" python3 - <<'PY'
import base64
import os
import sys
import urllib.request

credentials = f'{os.environ["HTTP_USER"]}:{os.environ["HTTP_PASSWORD"]}'.encode()
request = urllib.request.Request(
    os.environ["HTTP_URL"],
    data=os.environ["HTTP_BODY"].encode(),
    headers={
        "authorization": "Basic " + base64.b64encode(credentials).decode(),
        "content-type": "text/plain",
    },
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        sys.stdout.buffer.write(response.read())
except Exception:
    sys.exit(1)
PY
  elif command -v node >/dev/null 2>&1; then
    HTTP_URL="$url" HTTP_BODY="$body" HTTP_USER="$user" HTTP_PASSWORD="$password" node - <<'JS'
const auth = Buffer.from(`${process.env.HTTP_USER}:${process.env.HTTP_PASSWORD}`).toString('base64')

fetch(process.env.HTTP_URL, {
  method: 'POST',
  headers: {
    authorization: `Basic ${auth}`,
    'content-type': 'text/plain',
  },
  body: process.env.HTTP_BODY,
})
  .then(async response => {
    if (!response.ok) {
      process.exit(1)
    }
    process.stdout.write(await response.text())
  })
  .catch(() => process.exit(1))
JS
  else
    echo "curl, python3, or node is required for HTTP readiness checks" >&2
    return 127
  fi
}

qbit_cli() {
  if [[ -n "$QBIT_CLI_BIN" ]]; then
    "$QBIT_CLI_BIN" -regtest -rpcconnect="$QBIT_RPC_HOST" -rpcport="$QBIT_RPC_PORT" -rpcuser="$QBIT_RPC_USER" -rpcpassword="$QBIT_RPC_PASSWORD" "$@"
  elif command -v qbit-cli >/dev/null 2>&1; then
    qbit-cli -regtest -rpcconnect="$QBIT_RPC_HOST" -rpcport="$QBIT_RPC_PORT" -rpcuser="$QBIT_RPC_USER" -rpcpassword="$QBIT_RPC_PASSWORD" "$@"
  else
    compose exec -T "$QBIT_DOCKER_SERVICE" qbit-cli \
      -regtest -rpcconnect="$QBIT_CONTAINER_RPC_HOST" -rpcport="$QBIT_CONTAINER_RPC_PORT" -rpcuser="$QBIT_RPC_USER" -rpcpassword="$QBIT_RPC_PASSWORD" "$@"
  fi
}

wallet_cli() {
  local wallet_name="$1"
  shift
  qbit_cli -rpcwallet="$wallet_name" "$@"
}

ensure_wallet() {
  local wallet_name="$1"
  if qbit_cli listwallets | grep -q "\"$wallet_name\""; then
    return
  fi

  if qbit_cli loadwallet "$wallet_name" >/dev/null 2>&1; then
    return
  fi

  qbit_cli -named createwallet wallet_name="$wallet_name" disable_private_keys=false blank=false passphrase="" avoid_reuse=false descriptors=true load_on_startup=true >/dev/null 2>&1 ||
    qbit_cli createwallet "$wallet_name" false false "" false true true false >/dev/null 2>&1 ||
    qbit_cli createwallet "$wallet_name" false false "" false true true >/dev/null
}

wait_for_rpc() {
  local attempts="${1:-60}"
  local rpc_url="http://$QBIT_RPC_HOST:$QBIT_RPC_PORT/"
  local rpc_probe='{"jsonrpc":"1.0","id":"regtest-ready","method":"getblockchaininfo","params":[]}'
  local response

  for ((i = 1; i <= attempts; i++)); do
    if response="$(http_post_json_basic_auth "$rpc_url" "$rpc_probe" "$QBIT_RPC_USER" "$QBIT_RPC_PASSWORD" 2>/dev/null)" &&
      printf '%s' "$response" | grep -Eq '"error"[[:space:]]*:[[:space:]]*null' &&
      printf '%s' "$response" | grep -Eq '"result"[[:space:]]*:[[:space:]]*\{'; then
      return 0
    fi
    sleep 1
  done
  echo "qbit regtest RPC did not become ready at $rpc_url after $attempts seconds" >&2
  return 1
}

wait_for_electrs() {
  local attempts="${1:-60}"
  if [[ -z "$QBIT_ELECTRS_HTTP_URL" ]]; then
    return 0
  fi

  for ((i = 1; i <= attempts; i++)); do
    if http_get "$QBIT_ELECTRS_HTTP_URL/blocks/tip/height" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "electrs-qbit HTTP did not become ready at $QBIT_ELECTRS_HTTP_URL after $attempts seconds" >&2
  return 1
}

require_positive_integer() {
  local value="$1"
  local name="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    die "$name must be a positive integer, got: $value"
  fi
}
