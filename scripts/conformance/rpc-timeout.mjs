import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_QBIT_REGTEST_RPC_TIMEOUT_MS = 120_000
const processGroupSupervisor = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'process-group-supervisor.bash'
)

export function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer, got ${value}`)
  }
  return parsed
}

export function qbitRpcTimeoutMs(env = process.env) {
  return parsePositiveInteger(
    env.QBIT_REGTEST_RPC_TIMEOUT_MS || String(DEFAULT_QBIT_REGTEST_RPC_TIMEOUT_MS),
    'QBIT_REGTEST_RPC_TIMEOUT_MS'
  )
}

export function spawnQbitRpcSync(command, args, options = {}, env = process.env) {
  return spawnSync('bash', [processGroupSupervisor, command, ...args], {
    ...options,
    timeout: qbitRpcTimeoutMs(env),
    // The supervisor traps TERM, kills the command's complete process group,
    // and then terminates itself with KILL so spawnSync retains hard-timeout
    // behavior without leaving descendants behind.
    killSignal: 'SIGTERM',
  })
}
