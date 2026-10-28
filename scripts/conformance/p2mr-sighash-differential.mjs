#!/usr/bin/env node
// C3 differential test (issue #16, acceptance #2): build a single-key P2MR spend
// entirely in TypeScript — derive the address, compute the P2MRSighash (C3),
// PQC-sign it (@qbit-oss/pqc), assemble the witness + extract the tx (C5) — then submit
// it to a live qbitd via `testmempoolaccept`. Acceptance proves our sighash digest
// matches qbit consensus byte-for-byte. Uses the G1 regtest harness (qbitd only).
//
// Run via `pnpm test:integration:p2mr-differential`.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Route all RPC through the harness CLI wrapper (it sources scripts/regtest/env.sh),
// so the test honors every harness override — QBIT_REGTEST_COMPOSE_FILE,
// QBIT_REGTEST_CLI, QBIT_REGTEST_RPC_HOST/PORT, QBIT_REGTEST_DOCKER_SERVICE — and
// works against a host-only node, exactly like smoke-regtest-harness.mjs.
const regtestCli = resolve(root, 'scripts/regtest/cli')
const FUND_WALLET = 'c3-diff-fund'
// The SDK is installed from npm; resolve the copies keyring-service signs with.
const sdkRequire = createRequire(resolve(root, 'packages/keyring-service/package.json'))

function cli(args, { wallet } = {}) {
  const fullArgs = [regtestCli, ...(wallet ? [`-rpcwallet=${wallet}`] : []), ...args]
  const r = spawnSync('bash', fullArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`qbit-cli ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout.trim()
}
const cliJson = (args, opts) => JSON.parse(cli(args, opts))

function harnessReachable() {
  const r = spawnSync('bash', [regtestCli, 'getblockchaininfo'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return r.status === 0
}

function coinbaseMaturity() {
  const raw = process.env.QBIT_REGTEST_COINBASE_MATURITY
  if (raw === undefined || raw === '') return 1000
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`QBIT_REGTEST_COINBASE_MATURITY must be a positive integer, got: ${raw}`)
  }
  return Number(raw)
}

function coinToBaseUnits(value) {
  const [whole, frac = ''] = String(value).split('.')
  return BigInt(whole) * 100_000_000n + BigInt((frac + '00000000').slice(0, 8))
}

// Imported only after the skip check, so a down-harness run never needs them.
async function loadSdk() {
  const protocolRoot = dirname(sdkRequire.resolve('@qbit-oss/protocol/package.json'))
  const [pqc, proto] = await Promise.all([
    import(pathToFileURL(sdkRequire.resolve('@qbit-oss/pqc')).href),
    import(pathToFileURL(resolve(protocolRoot, 'lib/index.mjs')).href),
  ])
  return { ...pqc, ...proto }
}

const t0 = Date.now()
const step = (msg) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

async function main() {
  // Skip cleanly when the harness isn't running, unless this is a required gate.
  // (No SDK import yet, so the skip path can't fail on unbuilt packages.)
  if (!harnessReachable()) {
    if (process.env.QBIT_REGTEST_REQUIRED === '1' || process.env.QBIT_REGTEST_SMOKE_REQUIRED === '1') {
      throw new Error('qbit regtest harness is not reachable (qbitd RPC down)')
    }
    console.log('SKIP: qbit regtest harness not running (set QBIT_REGTEST_REQUIRED=1 to require)')
    return
  }

  const MATURITY = coinbaseMaturity()
  const {
    init: pqcInit, keygen, sign: pqcSign, constants: pqcConstants,
    singleKeyLeafScript, p2mrLeafHash, p2mrScriptPubKey, p2mrAddressFromPubkey,
    buildControlBlock, createP2mrPsbt, signP2mrPsbt, finalizeP2mrPsbt, extractP2mrTransaction,
    bytesToHex, hexToBytes, P2MR_LEAF_VERSION_V1,
  } = await loadSdk()

  // 1. Initialize PQC (prebuilt WASM) and generate an SLH-DSA key.
  const wasmBinary = readFileSync(sdkRequire.resolve('@qbit-oss/pqc/wasm/pqc.wasm'))
  await pqcInit({ wasmBinary })
  const entropy = new Uint8Array(pqcConstants.MIN_ENTROPY)
  webcrypto.getRandomValues(entropy)
  const { publicKey, secretKey } = keygen(entropy)
  step(`PQC key: pk=${publicKey.length}B sk=${secretKey.length}B`)

  // 2. Derive the single-key P2MR address / scriptPubKey (root == leaf hash for one leaf).
  const leafScript = singleKeyLeafScript(publicKey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
  const address = p2mrAddressFromPubkey(publicKey, 'regtest')
  step(`P2MR address ${address}`)

  // 3. Fund it through Core's own wallet (mine to maturity, then send).
  try { cli(['createwallet', FUND_WALLET]) }
  catch { try { cli(['loadwallet', FUND_WALLET]) } catch { /* already loaded */ } }
  const mineAddr = cli(['getnewaddress'], { wallet: FUND_WALLET })
  step(`mining ${MATURITY + 1} blocks for coinbase maturity...`)
  cli(['generatetoaddress', String(MATURITY + 1), mineAddr], { wallet: FUND_WALLET })
  const fundTxid = cli(['sendtoaddress', address, '1.0'], { wallet: FUND_WALLET })
  cli(['generatetoaddress', '1', mineAddr], { wallet: FUND_WALLET })
  const fundTx = cliJson(['getrawtransaction', fundTxid, 'true'])
  const spkHex = bytesToHex(scriptPubKey)
  const out = fundTx.vout.find((o) => o.scriptPubKey.hex === spkHex)
  if (!out) throw new Error(`funded output not found (expected scriptPubKey ${spkHex})`)
  const fundValue = coinToBaseUnits(out.value)
  step(`funded vout=${out.n} value=${fundValue} sats, scriptPubKey matches TS derivation`)

  // 4. Build a spend back to a Core address.
  const destAddr = cli(['getnewaddress'], { wallet: FUND_WALLET })
  const destSpk = hexToBytes(cliJson(['getaddressinfo', destAddr], { wallet: FUND_WALLET }).scriptPubKey)
  const fee = 100_000n
  const psbt = createP2mrPsbt({
    inputs: [{
      prevout: { txid: hexToBytes(fundTxid).reverse(), vout: out.n },
      witnessUtxo: { value: fundValue, scriptPubKey },
      leafScript,
      controlBlock,
    }],
    outputs: [{ value: fundValue - fee, scriptPubKey: destSpk }],
  })

  // 5. Sign (C3 sighash + PQC), finalize, extract the network tx (C5).
  const { psbt: signedPsbt, signed } = signP2mrPsbt({
    psbt,
    keys: [{ inputIndex: 0, pubkey: publicKey, leafHash }],
    sign: (sighash) => pqcSign(secretKey, sighash),
  })
  if (signed.length !== 1) throw new Error('expected one signed input')
  const rawHex = bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(signedPsbt)))
  step(`built signed tx (${rawHex.length / 2} bytes)`)

  // 6. The differential gate: does qbit consensus accept our TS-computed sighash?
  const [accept] = cliJson(['testmempoolaccept', JSON.stringify([rawHex])])
  step(`testmempoolaccept: ${JSON.stringify(accept)}`)
  if (!accept.allowed) throw new Error(`qbitd REJECTED the TS-signed spend: ${accept['reject-reason']}`)

  // 7. Broadcast + confirm for good measure.
  const txid = cli(['sendrawtransaction', rawHex])
  cli(['generatetoaddress', '1', mineAddr], { wallet: FUND_WALLET })
  const conf = cliJson(['getrawtransaction', txid, 'true'])
  step(`CONFIRMED txid=${txid} confirmations=${conf.confirmations ?? 0}`)
  console.log('\n✅ C3 DIFFERENTIAL PASS — TS p2mrSighash-signed P2MR spend accepted + confirmed by qbitd')
}

main().catch((e) => { console.error(`\n❌ FAIL: ${e.message}`); process.exit(1) })
