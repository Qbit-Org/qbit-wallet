#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const required = process.env.QBIT_REGTEST_REQUIRED === '1'
const cli = resolve(root, 'scripts/regtest/cli')

function skip(message) {
  if (required) {
    console.error(`[qbit-regtest] ${message}`)
    process.exit(1)
  }
  console.log(`[qbit-regtest] SKIP: ${message}`)
  process.exit(0)
}

if (!existsSync(cli)) {
  skip('scripts/regtest/cli is missing')
}

const result = spawnSync('bash', [cli, 'getblockchaininfo'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (result.status !== 0) {
  skip(
    [
      'qbit regtest RPC is not reachable.',
      'Start it with `corepack pnpm regtest:up`, or point QBIT_REGTEST_RPC_HOST/PORT at an existing node.',
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join(' ')
  )
}

const info = JSON.parse(result.stdout)
if (info.chain !== 'regtest') {
  console.error(`[qbit-regtest] expected regtest chain, got ${info.chain}`)
  process.exit(1)
}

console.log(
  `[qbit-regtest] OK: chain=${info.chain} blocks=${info.blocks} headers=${info.headers}`
)
