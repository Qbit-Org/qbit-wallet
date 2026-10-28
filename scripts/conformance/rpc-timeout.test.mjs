import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  DEFAULT_QBIT_REGTEST_RPC_TIMEOUT_MS,
  qbitRpcTimeoutMs,
  spawnQbitRpcSync,
} from './rpc-timeout.mjs'

test('qbit RPC timeout rejects invalid values', () => {
  assert.equal(qbitRpcTimeoutMs({}), DEFAULT_QBIT_REGTEST_RPC_TIMEOUT_MS)
  assert.equal(qbitRpcTimeoutMs({ QBIT_REGTEST_RPC_TIMEOUT_MS: '250' }), 250)
  assert.throws(
    () => qbitRpcTimeoutMs({ QBIT_REGTEST_RPC_TIMEOUT_MS: '0' }),
    /must be a positive integer/
  )
  assert.throws(
    () => qbitRpcTimeoutMs({ QBIT_REGTEST_RPC_TIMEOUT_MS: '9007199254740992' }),
    /must be a safe positive integer/
  )
})

test('qbit RPC subprocess wrapper preserves output and exit status', () => {
  const result = spawnQbitRpcSync(
    'bash',
    ['-c', 'printf "rpc-out"; printf "rpc-error" >&2; exit 23'],
    { encoding: 'utf8' }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.status, 23)
  assert.equal(result.stdout, 'rpc-out')
  assert.equal(result.stderr, 'rpc-error')
})

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

test('qbit RPC subprocess wrapper forcibly terminates a stuck process tree', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'qbit-rpc-timeout-'))
  const grandchildPidPath = join(temporary, 'grandchild.pid')
  t.after(() => rmSync(temporary, { recursive: true, force: true }))

  const started = Date.now()
  const result = spawnQbitRpcSync(
    'bash',
    [
      '-c',
      'sleep 60 & grandchild=$!; printf "%s\\n" "$grandchild" > "$1"; wait "$grandchild"',
      'qbit-rpc-timeout-fixture',
      grandchildPidPath,
    ],
    { encoding: 'utf8' },
    { QBIT_REGTEST_RPC_TIMEOUT_MS: '250' }
  )

  assert.equal(result.error?.code, 'ETIMEDOUT')
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(Date.now() - started < 3_000, 'stuck subprocess was not terminated promptly')

  const grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8').trim())
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0)
  // The supervisor group-kills before spawnSync returns, but the orphaned
  // grandchild is torn down and reaped by init asynchronously, so a single
  // immediate probe can still see it as a zombie. Poll within a hard deadline.
  const teardownDeadline = Date.now() + 2_000
  while (processExists(grandchildPid)) {
    assert.ok(Date.now() < teardownDeadline, 'grandchild process survived the timeout')
    await delay(25)
  }
})
