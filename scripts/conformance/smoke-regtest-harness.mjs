#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = resolve(root, 'scripts/regtest/cli')
const mine = resolve(root, 'scripts/regtest/mine')
const fund = resolve(root, 'scripts/regtest/fund')
const required =
  process.env.QBIT_REGTEST_REQUIRED === '1' ||
  process.env.QBIT_REGTEST_SMOKE_REQUIRED === '1'
const fundingWallet = process.env.QBIT_FUNDING_WALLET || 'qbit-funding'
const smokeWallet = process.env.QBIT_REGTEST_SMOKE_WALLET || 'qbit-smoke'
const fundAmount = process.env.QBIT_REGTEST_SMOKE_FUND_AMOUNT || '0.01'
const spendAmount = process.env.QBIT_REGTEST_SMOKE_SPEND_AMOUNT || '0.001'
const electrsUrl = (process.env.QBIT_REGTEST_ELECTRS_HTTP_URL || 'http://127.0.0.1:3002').replace(
  /\/+$/,
  ''
)
const electrsAttempts = Number.parseInt(
  process.env.QBIT_REGTEST_ELECTRS_POLL_ATTEMPTS || '60',
  10
)

function exitSkip(message) {
  if (required) {
    console.error(`[qbit-regtest-smoke] ${message}`)
    process.exit(1)
  }
  console.log(`[qbit-regtest-smoke] SKIP: ${message}`)
  process.exit(0)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function runScript(script, args) {
  return run('bash', [script, ...args])
}

function runCli(args) {
  return runScript(cli, args)
}

function tryRunCli(args) {
  const result = spawnSync('bash', [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result
}

function ensureWallet(walletName) {
  const loaded = JSON.parse(runCli(['listwallets']))
  if (loaded.includes(walletName)) {
    return
  }

  const load = tryRunCli(['loadwallet', walletName])
  if (load.status === 0) {
    return
  }

  const createNamed = tryRunCli([
    '-named',
    'createwallet',
    `wallet_name=${walletName}`,
    'disable_private_keys=false',
    'blank=false',
    'passphrase=',
    'avoid_reuse=false',
    'descriptors=true',
    'load_on_startup=true',
  ])
  if (createNamed.status === 0) {
    return
  }

  runCli(['createwallet', walletName, 'false', 'false', '', 'false', 'true', 'true'])
}

async function waitForElectrsUtxo(address, txid) {
  if (!electrsUrl) {
    exitSkip('QBIT_REGTEST_ELECTRS_HTTP_URL is empty; electrs UTXO check disabled.')
  }

  let lastError = ''
  for (let i = 1; i <= electrsAttempts; i += 1) {
    try {
      const response = await fetch(`${electrsUrl}/address/${address}/utxo`)
      if (response.ok) {
        const utxos = await response.json()
        if (Array.isArray(utxos) && utxos.some((utxo) => utxo.txid === txid)) {
          return
        }
        lastError = `txid ${txid} was not in electrs UTXO response`
      } else {
        lastError = `HTTP ${response.status} from electrs`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }

  throw new Error(
    `electrs did not report funded UTXO for ${address} after ${electrsAttempts} attempts: ${lastError}`
  )
}

async function waitForElectrsTxConfirmed(txid) {
  let lastError = ''
  for (let i = 1; i <= electrsAttempts; i += 1) {
    try {
      const response = await fetch(`${electrsUrl}/tx/${txid}/status`)
      if (response.ok) {
        const status = await response.json()
        if (status?.confirmed === true) {
          return
        }
        lastError = `tx ${txid} is not confirmed in electrs status response`
      } else {
        lastError = `HTTP ${response.status} from electrs`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }

  throw new Error(`electrs did not confirm tx ${txid} after ${electrsAttempts} attempts: ${lastError}`)
}

for (const path of [cli, mine, fund]) {
  if (!existsSync(path)) {
    exitSkip(`${path.replace(`${root}/`, '')} is missing`)
  }
}

try {
  const info = JSON.parse(runCli(['getblockchaininfo']))
  if (info.chain !== 'regtest') {
    throw new Error(`expected chain=regtest, got ${info.chain}`)
  }
} catch (error) {
  exitSkip(
    [
      'qbit regtest RPC is not reachable.',
      'Start it with `corepack pnpm regtest:up`, or point QBIT_REGTEST_RPC_HOST/PORT at an existing node.',
      error instanceof Error ? error.message : String(error),
    ]
      .filter(Boolean)
      .join(' ')
  )
}

try {
  ensureWallet(fundingWallet)
  ensureWallet(smokeWallet)

  const targetAddress = runCli([`-rpcwallet=${smokeWallet}`, 'getnewaddress'])
  const fundTxid = runScript(fund, [targetAddress, fundAmount])

  await waitForElectrsUtxo(targetAddress, fundTxid)

  const spendTarget = runCli([`-rpcwallet=${fundingWallet}`, 'getnewaddress'])
  const spendTxid = runCli([`-rpcwallet=${smokeWallet}`, 'sendtoaddress', spendTarget, spendAmount])
  runScript(mine, ['1'])

  const spend = JSON.parse(runCli([`-rpcwallet=${smokeWallet}`, 'gettransaction', spendTxid]))
  if ((spend.confirmations || 0) < 1) {
    throw new Error(`Core-built spend ${spendTxid} was not confirmed`)
  }
  await waitForElectrsTxConfirmed(spendTxid)

  console.log(
    [
      '[qbit-regtest-smoke] OK:',
      `funded=${fundTxid}`,
      `address=${targetAddress}`,
      `wallet=${smokeWallet}`,
      `spent=${spendTxid}`,
      `confirmations=${spend.confirmations}`,
    ].join(' ')
  )
} catch (error) {
  console.error(`[qbit-regtest-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
