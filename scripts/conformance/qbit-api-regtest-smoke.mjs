#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = resolve(root, 'scripts/regtest/cli')
const fund = resolve(root, 'scripts/regtest/fund')
// The @qbit-oss/api the wallet installs (wallet-background resolves it).
const qbitApiEntry = resolve(
  dirname(
    createRequire(resolve(root, 'packages/wallet-background/package.json')).resolve(
      '@qbit-oss/api/package.json'
    )
  ),
  'lib/index.mjs'
)
const required =
  process.env.QBIT_REGTEST_REQUIRED === '1' ||
  process.env.QBIT_REGTEST_API_REQUIRED === '1'
const fundingWallet = process.env.QBIT_FUNDING_WALLET || 'qbit-funding'
const smokeWallet = process.env.QBIT_REGTEST_API_WALLET || 'qbit-api-smoke'
const fundAmount = process.env.QBIT_REGTEST_API_FUND_AMOUNT || '0.01'
const electrsUrl = (process.env.QBIT_REGTEST_ELECTRS_HTTP_URL || 'http://127.0.0.1:3002').replace(
  /\/+$/,
  ''
)
const attempts = Number.parseInt(process.env.QBIT_REGTEST_ELECTRS_POLL_ATTEMPTS || '60', 10)

function exitSkip(message) {
  if (required) {
    console.error(`[qbit-api-regtest] ${message}`)
    process.exit(1)
  }
  console.log(`[qbit-api-regtest] SKIP: ${message}`)
  process.exit(0)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
  return spawnSync('bash', [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function ensureWallet(walletName) {
  const loaded = JSON.parse(runCli(['listwallets']))
  if (loaded.includes(walletName)) return

  const load = tryRunCli(['loadwallet', walletName])
  if (load.status === 0) return

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
  if (createNamed.status === 0) return

  runCli(['createwallet', walletName, 'false', 'false', '', 'false', 'true', 'true'])
}

async function waitForClientFundedView(client, address, txid) {
  let lastError = ''
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const [utxos, balance, stats, txs, status] = await Promise.all([
        client.getAddressUtxos(address),
        client.getAddressBalance(address),
        client.getAddressStats(address),
        client.getAddressTxs(address),
        client.getTxStatus(txid),
      ])
      const hasUtxo = utxos.some(utxo => utxo.txid === txid)
      const hasHistory = txs.some(item => item.txid === txid)
      if (
        hasUtxo &&
        balance.totalSats > 0 &&
        stats.chain_stats.tx_count >= 1 &&
        hasHistory &&
        status.confirmed === true
      ) {
        return { balance, stats, txs, status }
      }
      lastError = [
        `utxo=${hasUtxo}`,
        `balance=${balance.totalSats}`,
        `chainTxs=${stats.chain_stats.tx_count}`,
        `history=${hasHistory}`,
        `confirmed=${status.confirmed}`,
      ].join(' ')
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }
  throw new Error(`@qbit-oss/api did not report confirmed funded view after ${attempts} attempts: ${lastError}`)
}

async function ensureElectrsReady() {
  let lastError = ''
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(`${electrsUrl}/blocks/tip/height`)
      if (response.ok) return
      lastError = `HTTP ${response.status} from electrs`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }
  exitSkip(`electrs-qbit HTTP is not reachable at ${electrsUrl}: ${lastError}`)
}

for (const path of [cli, fund]) {
  if (!existsSync(path)) {
    exitSkip(`${path.replace(`${root}/`, '')} is missing`)
  }
}
if (!electrsUrl) {
  exitSkip('QBIT_REGTEST_ELECTRS_HTTP_URL is empty')
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
  await ensureElectrsReady()
  ensureWallet(fundingWallet)
  ensureWallet(smokeWallet)

  if (!existsSync(qbitApiEntry)) {
    throw new Error(`${qbitApiEntry} is missing; run \`corepack pnpm install\` first`)
  }
  const { EsploraClient } = await import(pathToFileURL(qbitApiEntry).href)
  const client = new EsploraClient({ baseUrl: electrsUrl })
  const targetAddress = runCli([`-rpcwallet=${smokeWallet}`, 'getnewaddress'])
  const fundTxid = runScript(fund, [targetAddress, fundAmount])

  const { balance, stats, txs, status } = await waitForClientFundedView(
    client,
    targetAddress,
    fundTxid
  )

  const [tx, tiers, tipHeight, tipHash] = await Promise.all([
    client.getTx(fundTxid),
    client.getFeeTiers(),
    client.getTipHeight(),
    client.getTipHash(),
  ])

  if (balance.totalSats <= 0) {
    throw new Error(`expected positive balance, got ${balance.totalSats}`)
  }
  if (stats.chain_stats.tx_count < 1) {
    throw new Error(`expected at least one confirmed tx, got ${stats.chain_stats.tx_count}`)
  }
  if (!txs.some(item => item.txid === fundTxid)) {
    throw new Error(`funding tx ${fundTxid} missing from address history`)
  }
  if (tx.txid !== fundTxid) {
    throw new Error(`getTx returned ${tx.txid}, expected ${fundTxid}`)
  }
  if (status.confirmed !== true) {
    throw new Error(`funding tx ${fundTxid} was not confirmed`)
  }
  if (tiers.length === 0) {
    throw new Error('fee tier response was empty')
  }
  if (!Number.isInteger(tipHeight) || !tipHash) {
    throw new Error(`invalid tip response height=${tipHeight} hash=${tipHash}`)
  }

  console.log(
    [
      '[qbit-api-regtest] OK:',
      `address=${targetAddress}`,
      `funded=${fundTxid}`,
      `balance=${balance.totalSats}`,
      `history=${txs.length}`,
      `tip=${tipHeight}`,
    ].join(' ')
  )
} catch (error) {
  console.error(`[qbit-api-regtest] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
