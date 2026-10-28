#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  checkSdkPackages,
  MATRIX_SDK_PACKAGES,
  sdkPackageIdentities,
} from '../security/check-sdk-packages.mjs'
import { redactSensitive } from './redact-sensitive.mjs'
import { parsePositiveInteger, spawnQbitRpcSync } from './rpc-timeout.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const regtestCli = resolve(root, 'scripts/regtest/cli')
const required = process.env.QBIT_REGTEST_REQUIRED === '1'
const fundingWallet = process.env.QBIT_FUNDING_WALLET || 'qbit-funding'
const maturity = parsePositiveInteger(
  process.env.QBIT_REGTEST_COINBASE_MATURITY || '1000',
  'QBIT_REGTEST_COINBASE_MATURITY'
)
const derivationCount = 20
const fixedMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const runSuffix = `${process.pid}-${Date.now().toString(36)}`
const corePin = JSON.parse(readFileSync(resolve(root, 'scripts/conformance/core-pin.json'), 'utf8'))
const matrixFixture = JSON.parse(
  readFileSync(resolve(root, 'scripts/conformance/fixtures/matrix.json'), 'utf8')
)
const messageProofFixture = JSON.parse(
  readFileSync(resolve(root, 'scripts/conformance/fixtures/message-proof.json'), 'utf8')
)

let protocol
let pqc
let walletShared
let QbitHdKeyring
let fundingAddress

class ConformanceFailure extends Error {
  constructor(row, fixture, expected, actual, detail) {
    const compared = [
      `[qbit-conformance:${row}] ${fixture}`,
      detail,
      `expected=${formatValue(expected)}`,
      `actual=${formatValue(actual)}`,
    ]
      .filter(Boolean)
      .join('\n')
    super(compared)
    this.name = 'ConformanceFailure'
  }
}

function formatValue(value) {
  if (value instanceof Uint8Array) return summarizeSensitive(Buffer.from(value).toString('hex'))
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') return JSON.stringify(summarizeSensitive(value))
  return summarizeSensitive(
    JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === 'bigint') return `${item}n`
        if (item instanceof Uint8Array) return Buffer.from(item).toString('hex')
        return item
      },
      2
    )
  )
}

function summarizeSensitive(value) {
  const redacted = redactSensitive(value)
  if (redacted.length <= 512) return redacted
  return `<redacted-payload length=${redacted.length} sha256=${createHash('sha256')
    .update(redacted)
    .digest('hex')}>`
}

function expectEqual(row, fixture, actual, expected, detail) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new ConformanceFailure(row, fixture, expected, actual, detail)
  }
}

function expectTrue(row, fixture, actual, detail) {
  if (actual !== true) {
    throw new ConformanceFailure(row, fixture, true, actual, detail)
  }
}

function expectIndexed(row, fixture, actual, expected) {
  expectEqual(row, `${fixture}:length`, actual.length, expected.length)
  for (const [index, expectedValue] of expected.entries()) {
    expectEqual(row, `${fixture}:index-${index}`, actual[index], expectedValue)
  }
}

function run(command, args, options = {}, spawn = spawnSync) {
  const result = spawn(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
      .filter(Boolean)
      .map(summarizeSensitive)
      .join('\n')
    const renderedArgs = args.map(arg => summarizeSensitive(arg)).join(' ')
    throw new Error(`${command} ${renderedArgs} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout?.trim() || ''
}

function tryRun(command, args, options = {}, spawn = spawnSync) {
  return spawn(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function cli(args) {
  return run('bash', [regtestCli, ...args], {}, spawnQbitRpcSync)
}

function tryCli(args) {
  return tryRun('bash', [regtestCli, ...args], {}, spawnQbitRpcSync)
}

function cliJson(args) {
  const output = cli(args)
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`qbit-cli ${args[0]} returned invalid JSON: ${output}\n${error.message}`)
  }
}

function walletCli(wallet, args) {
  return cli([`-rpcwallet=${wallet}`, ...args])
}

function walletCliJson(wallet, args) {
  return cliJson([`-rpcwallet=${wallet}`, ...args])
}

function tryWalletCli(wallet, args) {
  return tryCli([`-rpcwallet=${wallet}`, ...args])
}

function coinToBaseUnits(value) {
  const normalized = Number(value).toFixed(8)
  const [whole, fraction] = normalized.split('.')
  return BigInt(whole) * 100_000_000n + BigInt(fraction)
}

function baseUnitsToCoin(value) {
  const sats = BigInt(value)
  const whole = sats / 100_000_000n
  const fraction = (sats % 100_000_000n).toString().padStart(8, '0')
  return `${whole}.${fraction}`
}

function txidBytes(txid) {
  return protocol.hexToBytes(txid).reverse()
}

function base64Psbt(psbt) {
  return Buffer.from(protocol.serializePsbt(psbt)).toString('base64')
}

function parseBase64Psbt(value) {
  return protocol.parsePsbt(new Uint8Array(Buffer.from(value, 'base64')))
}

function skip(message) {
  if (required) throw new Error(message)
  console.log(`[qbit-conformance] SKIP: ${message}`)
  process.exit(0)
}

function preflight() {
  expectEqual(
    'preflight',
    'matrix-fixture-core-source-baseline',
    matrixFixture.provenance.coreEvidence.sourceBaseline,
    corePin.sourceBaseline
  )
  expectTrue(
    'preflight',
    'matrix-fixture-core-validation',
    matrixFixture.provenance.coreEvidence.validated
  )
  expectEqual(
    'preflight',
    'matrix-fixture-core-runtime-release',
    matrixFixture.provenance.coreEvidence.runtimeRelease,
    corePin.runtimeRelease
  )
  expectEqual(
    'preflight',
    'message-proof-fixture-source',
    {
      repository: messageProofFixture.source.repository,
      commit: messageProofFixture.source.commit,
    },
    {
      repository: corePin.sourceBaseline.repository,
      commit: corePin.sourceBaseline.commit,
    }
  )
  const probe = tryCli(['getblockchaininfo'])
  if (probe.error || probe.status !== 0) {
    const detail = [probe.error?.message, probe.stderr?.trim()].filter(Boolean).join(' ')
    skip(
      [
        'qbit regtest RPC is not reachable.',
        'Start it with `corepack pnpm regtest:up` or configure QBIT_REGTEST_CLI/RPC overrides.',
        detail,
      ]
        .filter(Boolean)
        .join(' ')
    )
  }
  const info = JSON.parse(probe.stdout)
  expectEqual('preflight', 'chain', info.chain, 'regtest')
  const networkInfo = cliJson(['getnetworkinfo'])
  const expectedRelease =
    process.env.QBIT_CONFORMANCE_EXPECTED_RELEASE || corePin.runtimeRelease.tag
  const expectedSubversion = `/qbit:${expectedRelease.replace(/^v/, '')}/`
  expectEqual(
    'preflight',
    'runtime-subversion',
    networkInfo.subversion,
    expectedSubversion,
    'Set QBIT_CONFORMANCE_EXPECTED_RELEASE when exercising a candidate runtime.'
  )

  // The SDK comes from npm: the installed copies must be the pinned tarballs,
  // and the fixture must have been generated with them.
  const sdkPackages = checkSdkPackages(root)
  expectEqual('preflight', 'sdk-package-pins', sdkPackages.errors.join('; '), '')
  expectEqual(
    'preflight',
    'matrix-fixture:qbit-sdk-packages',
    sdkPackageIdentities(sdkPackages.pins, MATRIX_SDK_PACKAGES),
    matrixFixture.provenance.qbitSdkPackages
  )
  console.log(
    `[qbit-conformance] preflight chain=regtest blocks=${info.blocks} fixture-pin=${corePin.fixtureSource.commit} baseline-runtime-source=${corePin.sourceBaseline.commit} expected-release=${expectedRelease} runtime=${networkInfo.subversion || networkInfo.version}`
  )
}

async function buildAndLoad() {
  console.log('[qbit-conformance] building conformance subjects...')
  run('corepack', ['pnpm', '--filter', '@qbit/keyring-service...', 'build'], { stdio: 'inherit' })
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const module = await import('@qbit/keyring-service/qbit-hd-keyring'); if (typeof module.QbitHdKeyring !== 'function') process.exit(1)",
    ],
    { cwd: resolve(root, 'packages/keyring-service') }
  )
  console.log('[qbit-conformance] verifying available B4 Core fixtures...')
  run(process.execPath, ['--test', 'scripts/conformance/pqc-package-vectors.test.mjs'], {
    stdio: 'inherit',
  })
  run(process.execPath, ['--test', 'scripts/conformance/protocol-package-vectors.test.mjs'], {
    stdio: 'inherit',
  })
  run(process.execPath, ['scripts/conformance/verify-p2mr-offline-fixture.mjs'], {
    stdio: 'inherit',
  })
  // The copies keyring-service signs with.
  const sdkRequire = createRequire(resolve(root, 'packages/keyring-service/package.json'))
  const protocolRoot = dirname(sdkRequire.resolve('@qbit-oss/protocol/package.json'))
  const [loadedProtocol, loadedPqc, loadedKeyring, loadedShared] = await Promise.all([
    import(pathToFileURL(join(protocolRoot, 'lib/index.mjs')).href),
    import(pathToFileURL(sdkRequire.resolve('@qbit-oss/pqc')).href),
    import(pathToFileURL(resolve(root, 'packages/keyring-service/lib/qbit-hd-keyring.mjs')).href),
    import(pathToFileURL(resolve(root, 'packages/wallet-shared/lib/index.mjs')).href),
  ])
  protocol = loadedProtocol
  pqc = loadedPqc
  walletShared = loadedShared
  QbitHdKeyring = loadedKeyring.QbitHdKeyring
  if (typeof QbitHdKeyring !== 'function') {
    throw new Error('@qbit/keyring-service did not export QbitHdKeyring')
  }
  await pqc.init({
    wasmBinary: readFileSync(sdkRequire.resolve('@qbit-oss/pqc/wasm/pqc.wasm')),
  })
}

function createWallet(wallet, { blank = false } = {}) {
  const loaded = cliJson(['listwallets'])
  if (loaded.includes(wallet)) return
  const load = tryCli(['loadwallet', wallet])
  if (load.status === 0) return
  cli([
    '-named',
    'createwallet',
    `wallet_name=${wallet}`,
    'disable_private_keys=false',
    `blank=${blank}`,
    'passphrase=',
    'avoid_reuse=false',
    'descriptors=true',
    'load_on_startup=true',
  ])
}

function mineOne() {
  if (!fundingAddress) fundingAddress = walletCli(fundingWallet, ['getnewaddress', '', 'p2mr'])
  cli(['generatetoaddress', '1', fundingAddress])
}

function ensureFunding() {
  createWallet(fundingWallet)
  const spendable = Number(walletCli(fundingWallet, ['getbalance']))
  if (Number.isFinite(spendable) && spendable >= 2) {
    const received = walletCliJson(fundingWallet, ['listreceivedbyaddress', '0', 'true'])
    fundingAddress = received.find(item => item.address)?.address
    if (!fundingAddress) {
      throw new Error(`${fundingWallet} has spendable funds but no reusable receive address`)
    }
    console.log(`[qbit-conformance] reusing ${spendable} QBT from ${fundingWallet}`)
    return
  }
  fundingAddress = walletCli(fundingWallet, ['getnewaddress', '', 'p2mr'])
  console.log(
    `[qbit-conformance] maturing ${maturity + 1} blocks once for shared wallet ${fundingWallet}`
  )
  cli(['generatetoaddress', String(maturity + 1), fundingAddress])
}

function fundingDestinationScript() {
  if (!fundingAddress) {
    throw new Error('funding destination is unavailable')
  }
  return protocol.hexToBytes(
    walletCliJson(fundingWallet, ['getaddressinfo', fundingAddress]).scriptPubKey
  )
}

function fundAddress(address, amountSats) {
  const txid = walletCli(fundingWallet, ['sendtoaddress', address, baseUnitsToCoin(amountSats)])
  mineOne()
  const tx = cliJson(['getrawtransaction', txid, 'true'])
  const expectedScript = protocol.bytesToHex(protocol.addressToScriptPubKey(address, 'regtest'))
  const output = tx.vout.find(item => item.scriptPubKey.hex === expectedScript)
  if (!output) {
    throw new ConformanceFailure(
      'setup',
      `funding-output:${txid}`,
      expectedScript,
      tx.vout.map(item => item.scriptPubKey.hex),
      'funding transaction did not contain the requested scriptPubKey'
    )
  }
  return {
    txid,
    vout: output.n,
    value: coinToBaseUnits(output.value),
    scriptPubKey: protocol.hexToBytes(output.scriptPubKey.hex),
  }
}

async function row(name, callback) {
  const started = Date.now()
  console.log(`[qbit-conformance:${name}] START`)
  try {
    await callback()
  } catch (error) {
    if (error instanceof ConformanceFailure) throw error
    throw new ConformanceFailure(
      name,
      'unexpected-error',
      'row completes without an unexpected error',
      error instanceof Error ? redactSensitive(error.message) : redactSensitive(error)
    )
  }
  console.log(`[qbit-conformance:${name}] PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}

async function derivationRow(context) {
  expectEqual('derivation', 'fixture-schema', matrixFixture.schemaVersion, 1)
  expectEqual('derivation', 'fixture-count', matrixFixture.derivation.count, derivationCount)
  const indexes = Array.from({ length: derivationCount }, (_value, index) => index)
  context.externalKeyring = new QbitHdKeyring({
    mnemonic: fixedMnemonic,
    activeIndexes: indexes,
    hdPath: "m/87'/1'/0'/0",
  })
  context.internalKeyring = new QbitHdKeyring({
    mnemonic: fixedMnemonic,
    activeIndexes: indexes,
    hdPath: "m/87'/1'/0'/1",
  })
  context.externalAccounts = await context.externalKeyring.getQbitAccounts()
  context.internalAccounts = await context.internalKeyring.getQbitAccounts()
  context.descriptors = await context.externalKeyring.exportP2mrDescriptors('regtest')

  const oursExternal = context.externalAccounts.map(account => account.addresses.regtest)
  const oursInternal = context.internalAccounts.map(account => account.addresses.regtest)
  expectIndexed(
    'derivation',
    'fixture-vs-ours:external-branch:indices-0-19',
    oursExternal,
    matrixFixture.derivation.externalRegtestAddresses
  )
  expectIndexed(
    'derivation',
    'fixture-vs-ours:internal-branch:indices-0-19',
    oursInternal,
    matrixFixture.derivation.internalRegtestAddresses
  )

  const range = JSON.stringify([0, derivationCount - 1])
  const coreExternal = cliJson(['deriveaddresses', context.descriptors.external.descriptor, range])
  const coreInternal = cliJson(['deriveaddresses', context.descriptors.internal.descriptor, range])
  expectIndexed(
    'derivation',
    'fixture-vs-core:external-branch:indices-0-19',
    coreExternal,
    matrixFixture.derivation.externalRegtestAddresses
  )
  expectIndexed(
    'derivation',
    'fixture-vs-core:internal-branch:indices-0-19',
    coreInternal,
    matrixFixture.derivation.internalRegtestAddresses
  )

  context.importWallet = `g2-import-${runSuffix}`
  createWallet(context.importWallet, { blank: true })
  const entries = protocol.formatP2mrImportDescriptors(
    {
      external: context.descriptors.external.descriptor,
      internal: context.descriptors.internal.descriptor,
    },
    [0, derivationCount - 1],
    'now'
  )
  const imported = walletCliJson(context.importWallet, [
    'importdescriptors',
    JSON.stringify(entries),
  ])
  expectIndexed(
    'derivation',
    'wallet-import-results',
    imported.map(result => result.success),
    [true, true],
    formatValue(imported)
  )

  const walletExternal = []
  const walletInternal = []
  const listedAfterImport = walletCliJson(context.importWallet, [
    'listdescriptors',
    'true',
  ]).descriptors.filter(item => item.desc.startsWith('mr('))
  const externalStart = listedAfterImport.find(item => !item.internal)?.next_index
  const internalStart = listedAfterImport.find(item => item.internal)?.next_index
  expectTrue('derivation', 'wallet-external-next-index', Number.isInteger(externalStart))
  expectTrue('derivation', 'wallet-internal-next-index', Number.isInteger(internalStart))
  for (let index = 0; index < derivationCount; index += 1) {
    walletExternal.push(walletCli(context.importWallet, ['getnewaddress', '', 'p2mr']))
    walletInternal.push(walletCli(context.importWallet, ['getrawchangeaddress', 'p2mr']))
  }
  const walletExternalExpected = await new QbitHdKeyring({
    mnemonic: fixedMnemonic,
    activeIndexes: Array.from(
      { length: derivationCount },
      (_value, index) => externalStart + index
    ),
    hdPath: "m/87'/1'/0'/0",
  }).getQbitAccounts()
  const walletInternalExpected = await new QbitHdKeyring({
    mnemonic: fixedMnemonic,
    activeIndexes: Array.from(
      { length: derivationCount },
      (_value, index) => internalStart + index
    ),
    hdPath: "m/87'/1'/0'/1",
  }).getQbitAccounts()
  expectIndexed(
    'derivation',
    `ours-vs-core-wallet:external-branch:indices-${externalStart}-${externalStart + derivationCount - 1}`,
    walletExternal,
    walletExternalExpected.map(account => account.addresses.regtest)
  )
  expectIndexed(
    'derivation',
    `ours-vs-core-wallet:internal-branch:indices-${internalStart}-${internalStart + derivationCount - 1}`,
    walletInternal,
    walletInternalExpected.map(account => account.addresses.regtest)
  )
}

async function descriptorsRow(context) {
  for (const branch of ['external', 'internal']) {
    const descriptor = context.descriptors[branch].descriptor
    expectEqual(
      'descriptors',
      `fixture-hash:${branch}`,
      createHash('sha256').update(descriptor).digest('hex'),
      matrixFixture.descriptors[`${branch}Sha256`]
    )
    const parsed = protocol.parseP2mrDescriptor(descriptor, { requireChecksum: true })
    expectEqual(
      'descriptors',
      `ours-round-trip:${branch}`,
      protocol.serializeP2mrDescriptor(parsed, true),
      descriptor
    )
  }

  const imported = walletCliJson(context.importWallet, ['listdescriptors', 'true']).descriptors
  const importedByBranch = new Map(
    imported
      .filter(item => item.desc.startsWith('mr('))
      .map(item => [item.internal ? 'internal' : 'external', item.desc])
  )
  expectEqual(
    'descriptors',
    'ours-export->core-import:external',
    importedByBranch.get('external'),
    context.descriptors.external.descriptor
  )
  expectEqual(
    'descriptors',
    'ours-export->core-import:internal',
    importedByBranch.get('internal'),
    context.descriptors.internal.descriptor
  )

  const nativeWallet = `g2-native-${runSuffix}`
  createWallet(nativeWallet)
  const nativeDescriptors = walletCliJson(nativeWallet, [
    'listdescriptors',
    'true',
  ]).descriptors.filter(item => item.desc.startsWith('mr('))
  expectEqual('descriptors', 'core-native-count', nativeDescriptors.length, 2)
  for (const item of nativeDescriptors) {
    const parsed = protocol.parseP2mrDescriptor(item.desc, { requireChecksum: true })
    expectEqual(
      'descriptors',
      `core-list->ours-round-trip:${item.internal ? 'internal' : 'external'}`,
      protocol.serializeP2mrDescriptor(parsed, true),
      item.desc
    )
  }
}

async function addressesRow(context) {
  const accounts = [...context.externalAccounts, ...context.internalAccounts]
  for (const account of accounts) {
    const address = account.addresses.regtest
    const decoded = protocol.decodeP2mrAddress(address, 'regtest')
    expectEqual(
      'addresses',
      `codec-round-trip:${account.path}`,
      protocol.encodeP2mrAddress(decoded.program, 'regtest'),
      address
    )
    const core = cliJson(['validateaddress', address])
    expectTrue('addresses', `core-valid:${account.path}`, core.isvalid)
    expectEqual(
      'addresses',
      `scriptPubKey:${account.path}`,
      core.scriptPubKey,
      account.scriptPubKey
    )
    expectEqual('addresses', `witness-version:${account.path}`, core.witness_version, 2)
    expectEqual(
      'addresses',
      `witness-program:${account.path}`,
      core.witness_program,
      protocol.bytesToHex(decoded.program)
    )
  }

  for (const fixture of matrixFixture.addresses.invalidRegtest) {
    let localAccepted = true
    try {
      protocol.decodeP2mrAddress(fixture.value, 'regtest')
    } catch {
      localAccepted = false
    }
    expectEqual('addresses', `invalid-local:${fixture.name}`, localAccepted, false)
    expectEqual(
      'addresses',
      `invalid-core:${fixture.name}`,
      cliJson(['validateaddress', fixture.value]).isvalid,
      false
    )
  }
}

async function signPsbtWithKeyring(psbt, keyring, account, leafHash, inputIndex = 0) {
  const secret = protocol.hexToBytes(await keyring.exportAccount(account.pubkey))
  try {
    return protocol.signP2mrPsbt({
      psbt,
      keys: [
        {
          inputIndex,
          pubkey: protocol.hexToBytes(account.pubkey),
          leafHash,
        },
      ],
      sign: digest => pqc.sign(secret, digest),
    }).psbt
  } finally {
    secret.fill(0)
  }
}

function makeSpendPsbt(account, funding, destinationScript, feeSats) {
  const leafScript = protocol.hexToBytes(account.leafScript)
  const leafHash = protocol.p2mrLeafHash(protocol.P2MR_LEAF_VERSION_V1, leafScript)
  const controlBlock = protocol.buildControlBlock(protocol.P2MR_LEAF_VERSION_V1, [])
  const psbt = protocol.createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: txidBytes(funding.txid), vout: funding.vout },
        witnessUtxo: { value: funding.value, scriptPubKey: funding.scriptPubKey },
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      },
    ],
    outputs: [
      {
        value: funding.value - BigInt(feeSats),
        scriptPubKey: destinationScript,
      },
    ],
  })
  return { psbt, leafScript, leafHash, controlBlock }
}

async function sighashSignRow(context) {
  const account = context.externalAccounts[0]
  const funding = fundAddress(account.addresses.regtest, 10_000_000n)
  const destinationScript = fundingDestinationScript()
  const spend = makeSpendPsbt(account, funding, destinationScript, 10_000n)
  const signed = await signPsbtWithKeyring(
    spend.psbt,
    context.externalKeyring,
    account,
    spend.leafHash
  )
  const finalized = protocol.finalizeP2mrPsbt(signed)
  const rawHex = protocol.bytesToHex(protocol.extractP2mrTransaction(finalized))
  const [accept] = cliJson(['testmempoolaccept', JSON.stringify([rawHex])])
  expectTrue(
    'sighash-sign',
    'typescript-signed-single-key:testmempoolaccept',
    accept.allowed,
    accept['reject-reason']
  )

  const txid = cli(['sendrawtransaction', rawHex])
  mineOne()
  const confirmed = cliJson(['getrawtransaction', txid, 'true'])
  expectTrue(
    'sighash-sign',
    'typescript-signed-single-key:mined',
    Number(confirmed.confirmations || 0) >= 1,
    `txid=${txid}`
  )
  context.signedSpend = {
    accept,
    rawHex,
    leafScriptLength: spend.leafScript.length,
    controlBlockLength: spend.controlBlock.length,
    outputScriptLength: destinationScript.length,
  }
}

async function txFeesRow(context) {
  const sizingFixture = matrixFixture.txFees
  expectEqual(
    'tx-fees',
    'fixture-vsize:two-outputs',
    walletShared.estimateQbitP2mrTransaction({
      inputCount: 1,
      outputScriptLengths: [sizingFixture.outputScriptLength, sizingFixture.outputScriptLength],
      leafScriptLength: sizingFixture.leafScriptLength,
      controlBlockLength: sizingFixture.controlBlockLength,
    }).vsize,
    sizingFixture.singleInputTwoOutputVsize
  )
  expectEqual(
    'tx-fees',
    'fixture-vsize:explicit-signature-item',
    walletShared.estimateQbitP2mrTransaction({
      inputCount: 1,
      outputScriptLengths: [sizingFixture.outputScriptLength],
      leafScriptLength: sizingFixture.leafScriptLength,
      controlBlockLength: sizingFixture.controlBlockLength,
      signatureItemLength: walletShared.QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES + 1,
    }).vsize,
    sizingFixture.explicitSignatureItemVsize
  )
  const predicted = walletShared.estimateQbitP2mrTransaction({
    inputCount: 1,
    outputScriptLengths: [context.signedSpend.outputScriptLength],
    leafScriptLength: context.signedSpend.leafScriptLength,
    controlBlockLength: context.signedSpend.controlBlockLength,
  }).vsize
  const decoded = cliJson(['decoderawtransaction', context.signedSpend.rawHex])
  expectEqual(
    'tx-fees',
    'fixture-vsize:single-input-single-output',
    predicted,
    matrixFixture.txFees.singleInputSingleOutputVsize
  )
  expectEqual('tx-fees', 'single-key-vsize:wallet-vs-core', predicted, decoded.vsize)
  expectEqual(
    'tx-fees',
    'single-key-vsize:mempool-vs-core-decode',
    context.signedSpend.accept.vsize,
    decoded.vsize
  )
  expectEqual(
    'tx-fees',
    'no-witness-discount:raw-bytes',
    context.signedSpend.rawHex.length / 2,
    decoded.vsize
  )
  expectEqual(
    'tx-fees',
    'p2mr-dust-constant',
    walletShared.QBIT_P2MR_DUST,
    matrixFixture.txFees.dustBoundarySats
  )

  const destination = context.externalAccounts[2].addresses.regtest
  const belowBoundary = BigInt(matrixFixture.txFees.dustBoundarySats - 1)
  const boundary = BigInt(matrixFixture.txFees.dustBoundarySats)
  const below = tryWalletCli(fundingWallet, [
    'sendtoaddress',
    destination,
    baseUnitsToCoin(belowBoundary),
  ])
  const belowDetail = [below.stderr?.trim(), below.stdout?.trim()].filter(Boolean).join('\n')
  expectTrue(
    'tx-fees',
    `dust:${belowBoundary}-rejected`,
    below.status !== 0 && belowDetail.includes('Transaction amount too small'),
    belowDetail
  )
  const boundaryTxid = walletCli(fundingWallet, [
    'sendtoaddress',
    destination,
    baseUnitsToCoin(boundary),
  ])
  expectEqual('tx-fees', `dust:${boundary}-accepted-txid-length`, boundaryTxid.length, 64)
  mineOne()
}

async function psbtRow(context) {
  const coreAccount = context.externalAccounts[0]
  const oursKeyring = new QbitHdKeyring({
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    activeIndexes: [0],
    hdPath: "m/87'/1'/0'/0",
  })
  const [oursAccount] = await oursKeyring.getQbitAccounts()
  const coreFunding = fundAddress(coreAccount.addresses.regtest, 10_000_000n)
  const oursFunding = fundAddress(oursAccount.addresses.regtest, 10_000_000n)
  const destinationScript = fundingDestinationScript()

  const coreLeafScript = protocol.hexToBytes(coreAccount.leafScript)
  const coreLeafHash = protocol.p2mrLeafHash(protocol.P2MR_LEAF_VERSION_V1, coreLeafScript)
  const oursLeafScript = protocol.hexToBytes(oursAccount.leafScript)
  const oursLeafHash = protocol.p2mrLeafHash(protocol.P2MR_LEAF_VERSION_V1, oursLeafScript)
  const controlBlock = protocol.buildControlBlock(protocol.P2MR_LEAF_VERSION_V1, [])
  const unsigned = protocol.createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: txidBytes(coreFunding.txid), vout: coreFunding.vout },
        witnessUtxo: {
          value: coreFunding.value,
          scriptPubKey: coreFunding.scriptPubKey,
        },
        leafScript: coreLeafScript,
        controlBlock,
        merkleRoot: coreLeafHash,
      },
      {
        prevout: { txid: txidBytes(oursFunding.txid), vout: oursFunding.vout },
        witnessUtxo: {
          value: oursFunding.value,
          scriptPubKey: oursFunding.scriptPubKey,
        },
        leafScript: oursLeafScript,
        controlBlock,
        merkleRoot: oursLeafHash,
      },
    ],
    outputs: [
      {
        value: coreFunding.value + oursFunding.value - 40_000n,
        scriptPubKey: destinationScript,
      },
    ],
  })
  const unsignedBase64 = base64Psbt(unsigned)
  const coreDecoded = cliJson(['decodepsbt', unsignedBase64])
  expectEqual('psbt', 'decode:input-count', coreDecoded.inputs.length, 2)
  expectEqual('psbt', 'decode:output-count', coreDecoded.tx.vout.length, 1)
  for (const [index, fixture] of [
    { funding: coreFunding, leafScript: coreLeafScript },
    { funding: oursFunding, leafScript: oursLeafScript },
  ].entries()) {
    expectEqual(
      'psbt',
      `decode:witness-value:input-${index}`,
      coinToBaseUnits(coreDecoded.inputs[index].witness_utxo.amount),
      fixture.funding.value
    )
    expectEqual(
      'psbt',
      `decode:witness-scriptPubKey:input-${index}`,
      coreDecoded.inputs[index].witness_utxo.scriptPubKey.hex,
      protocol.bytesToHex(fixture.funding.scriptPubKey)
    )
    expectEqual(
      'psbt',
      `decode:leaf-count:input-${index}`,
      coreDecoded.inputs[index].p2mr_scripts?.length || 0,
      1
    )
    expectEqual(
      'psbt',
      `decode:leaf-script:input-${index}`,
      coreDecoded.inputs[index].p2mr_scripts[0].script,
      protocol.bytesToHex(fixture.leafScript)
    )
  }
  expectEqual('psbt', 'decode:fee', coinToBaseUnits(coreDecoded.fee), 40_000n)

  const coreSignerWallet = `g2-psbt-core-${runSuffix}`
  createWallet(coreSignerWallet, { blank: true })
  const importResult = walletCliJson(coreSignerWallet, [
    'importdescriptors',
    JSON.stringify([
      {
        desc: context.descriptors.external.descriptor,
        timestamp: 'now',
        active: false,
        internal: false,
        range: [0, 0],
      },
    ]),
  ])
  expectEqual(
    'psbt',
    'core-partial-signer-import',
    importResult.map(result => result.success),
    [true]
  )

  const oursPartial = await signPsbtWithKeyring(unsigned, oursKeyring, oursAccount, oursLeafHash, 1)
  const oursPartialBase64 = base64Psbt(oursPartial)
  const corePartialResult = walletCliJson(coreSignerWallet, [
    'walletprocesspsbt',
    unsignedBase64,
    'true',
    'DEFAULT',
    'true',
    'false',
  ])
  const corePartial = parseBase64Psbt(corePartialResult.psbt)
  const oursSummary = protocol.decodePsbt(oursPartial)
  const coreSummary = protocol.decodePsbt(corePartial)
  expectEqual(
    'psbt',
    'ours-complementary-partial-signatures',
    oursSummary.inputs.map(input => input.scriptSigs.length),
    [0, 1]
  )
  expectEqual(
    'psbt',
    'core-complementary-partial-signatures',
    coreSummary.inputs.map(input => input.scriptSigs.length),
    [1, 0]
  )

  const tsCombined = protocol.combinePsbts([oursPartial, corePartial])
  const tsFinalized = protocol.finalizeP2mrPsbt(tsCombined)
  const tsRawHex = protocol.bytesToHex(protocol.extractP2mrTransaction(tsFinalized))
  const coreCombined = cli([
    'combinepsbt',
    JSON.stringify([oursPartialBase64, corePartialResult.psbt]),
  ])
  const coreFinalized = cliJson(['finalizepsbt', coreCombined, 'true'])
  expectTrue('psbt', 'core-finalize-complete', coreFinalized.complete)
  expectEqual('psbt', 'cross-finalized-raw-transaction', coreFinalized.hex, tsRawHex)
  const [accept] = cliJson(['testmempoolaccept', JSON.stringify([tsRawHex])])
  expectTrue('psbt', 'cross-finalized:testmempoolaccept', accept.allowed, accept['reject-reason'])
  const txid = cli(['sendrawtransaction', tsRawHex])
  mineOne()
  expectTrue(
    'psbt',
    'cross-finalized:mined',
    Number(cliJson(['getrawtransaction', txid, 'true']).confirmations || 0) >= 1,
    txid
  )
}

async function messageProofRow(context) {
  expectEqual(
    'message-proof',
    'fixture-mode',
    messageProofFixture.mode,
    'live-data-hash-proof-parity'
  )
  const account = context.externalAccounts[3]
  const address = account.addresses.regtest
  const messageHash = protocol.qbitWalletMessageHash(messageProofFixture.message)
  const dataSignatureHash = protocol.qbitDataSigPqcHash(messageHash)
  expectEqual(
    'message-proof',
    'wallet-message-domain-hash',
    protocol.bytesToHex(messageHash),
    messageProofFixture.messageHash
  )
  expectEqual(
    'message-proof',
    'wallet-data-signature-domain-hash',
    protocol.bytesToHex(dataSignatureHash),
    messageProofFixture.dataSignatureHash
  )
  expectEqual(
    'message-proof',
    `core-fixed-vector:${messageProofFixture.coreVector.name}`,
    protocol.bytesToHex(
      protocol.qbitDataSigPqcHash(protocol.hexToBytes(messageProofFixture.coreVector.messageHash))
    ),
    messageProofFixture.coreVector.dataSignatureHash
  )

  const coreProof = walletCliJson(context.importWallet, [
    'signdatapqchash',
    address,
    protocol.bytesToHex(messageHash),
  ])
  const wrappedCoreProof = {
    type: messageProofFixture.proofType,
    version: messageProofFixture.proofVersion,
    message_domain: messageProofFixture.messageDomain,
    ...coreProof,
  }
  expectEqual('message-proof', 'core-proof:address', coreProof.address, address)
  expectEqual(
    'message-proof',
    'core-proof:message-hash',
    coreProof.message_hash,
    messageProofFixture.messageHash
  )
  expectEqual(
    'message-proof',
    'core-proof:data-signature-hash',
    coreProof.datasig_hash,
    messageProofFixture.dataSignatureHash
  )
  expectEqual(
    'message-proof',
    'core-proof:identity',
    {
      domain: coreProof.domain,
      algorithm: coreProof.algorithm,
      proofMode: coreProof.proof_mode,
      leafVersion: coreProof.leaf_version,
    },
    {
      domain: messageProofFixture.dataSignatureDomain,
      algorithm: messageProofFixture.algorithm,
      proofMode: messageProofFixture.proofMode,
      leafVersion: messageProofFixture.leafVersion,
    }
  )
  // @qbit-oss/protocol binds a proof to the address and network it is for.
  const expectedProof = { expectedAddress: address, expectedNetwork: 'regtest' }
  expectTrue(
    'message-proof',
    'core-sign->wallet-verify',
    protocol.verifyP2mrMessageProof(
      messageProofFixture.message,
      wrappedCoreProof,
      pqc.verify,
      expectedProof
    )
  )
  const coreVerification = cliJson(['verifydatapqchash', JSON.stringify(wrappedCoreProof)])
  expectTrue(
    'message-proof',
    'core-sign->core-verify',
    coreVerification.valid,
    coreVerification.error
  )
  expectEqual(
    'message-proof',
    'core-verify:recomputed-fields',
    {
      address: coreVerification.address,
      messageHash: coreVerification.message_hash,
      dataSignatureHash: coreVerification.datasig_hash,
      pubkey: coreVerification.pubkey,
      proofMode: coreVerification.proof_mode,
      merkleRoot: coreVerification.p2mr_merkle_root,
    },
    {
      address,
      messageHash: wrappedCoreProof.message_hash,
      dataSignatureHash: wrappedCoreProof.datasig_hash,
      pubkey: wrappedCoreProof.pubkey,
      proofMode: wrappedCoreProof.proof_mode,
      merkleRoot: wrappedCoreProof.p2mr_merkle_root,
    }
  )

  const walletSignature = await context.externalKeyring.signPqcDigest(
    account.pubkey,
    dataSignatureHash
  )
  const walletProof = protocol.createP2mrMessageProof({
    message: messageProofFixture.message,
    address,
    pubkey: protocol.hexToBytes(account.pubkey),
    signature: walletSignature,
  })
  walletSignature.fill(0)
  expectTrue(
    'message-proof',
    'wallet-sign->wallet-verify',
    protocol.verifyP2mrMessageProof(
      messageProofFixture.message,
      walletProof,
      pqc.verify,
      expectedProof
    )
  )
  const walletProofCoreVerification = cliJson(['verifydatapqchash', JSON.stringify(walletProof)])
  expectTrue(
    'message-proof',
    'wallet-sign->core-verify',
    walletProofCoreVerification.valid,
    walletProofCoreVerification.error
  )
  expectEqual(
    'message-proof',
    'tampered-message:wallet-rejects',
    protocol.verifyP2mrMessageProof(
      `${messageProofFixture.message}!`,
      walletProof,
      pqc.verify,
      expectedProof
    ),
    false
  )
  const tamperedCoreProof = { ...walletProof, message_hash: '00'.repeat(32) }
  const tamperedCoreVerification = cliJson(['verifydatapqchash', JSON.stringify(tamperedCoreProof)])
  expectEqual(
    'message-proof',
    'tampered-message:core-rejects',
    tamperedCoreVerification.valid,
    false
  )
}

async function main() {
  preflight()
  await buildAndLoad()
  ensureFunding()
  const context = {}
  await row('derivation', () => derivationRow(context))
  await row('descriptors', () => descriptorsRow(context))
  await row('addresses', () => addressesRow(context))
  await row('sighash-sign', () => sighashSignRow(context))
  await row('tx-fees', () => txFeesRow(context))
  await row('psbt', () => psbtRow(context))
  await row('message-proof', () => messageProofRow(context))
  console.log('[qbit-conformance] PASS: 7/7 live Core rows')
}

main().catch(error => {
  console.error(
    redactSensitive(error instanceof Error ? error.stack || error.message : String(error))
  )
  process.exit(1)
})
