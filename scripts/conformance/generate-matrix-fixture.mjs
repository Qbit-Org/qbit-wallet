#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { format, resolveConfig } from 'prettier'
import {
  checkSdkPackages,
  MATRIX_SDK_PACKAGES,
  sdkPackageIdentities,
} from '../security/check-sdk-packages.mjs'
import { TREE_HASH_ALGORITHM } from './report-pin-diff.mjs'
import { spawnQbitRpcSync } from './rpc-timeout.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixedMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const count = 20
const indexes = Array.from({ length: count }, (_value, index) => index)
const args = process.argv.slice(2).filter(arg => arg !== '--')

function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const knownOptions = ['--core-cli', '--core-provenance', '--output']
for (const arg of args) {
  if (arg.startsWith('--') && !knownOptions.includes(arg)) {
    throw new Error(`unknown option ${arg}`)
  }
}

const coreCliPath = option('--core-cli')
const coreProvenancePath = option('--core-provenance')
const outputPath = option('--output')

if (coreCliPath) {
  if (!coreProvenancePath) throw new Error('--core-cli requires --core-provenance')
} else if (coreProvenancePath) {
  throw new Error('--core-provenance requires --core-cli')
}

function readCoreProvenance(path) {
  const evidence = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  const expectedKeys = [
    'binding',
    'checksumSignatureAsset',
    'commit',
    'linuxArm64ArchiveSha256',
    'linuxX64ArchiveSha256',
    'releaseSignerFingerprint',
    'repository',
    'schemaVersion',
    'tag',
  ]
  if (
    evidence === null ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    !isDeepStrictEqual(Object.keys(evidence).sort(), expectedKeys)
  ) {
    throw new Error('Core provenance evidence has an unsupported schema')
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.binding !== 'qbit-signed-release-tag-and-checksums-v1' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(evidence.repository) ||
    !/^v[0-9A-Za-z][0-9A-Za-z._-]*$/.test(evidence.tag) ||
    !/^[0-9a-f]{40}$/.test(evidence.commit) ||
    !/^[0-9A-F]{40}$/.test(evidence.releaseSignerFingerprint) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(evidence.checksumSignatureAsset) ||
    !/^[0-9a-f]{64}$/.test(evidence.linuxX64ArchiveSha256) ||
    !(
      evidence.linuxArm64ArchiveSha256 === null ||
      /^[0-9a-f]{64}$/.test(evidence.linuxArm64ArchiveSha256)
    )
  ) {
    throw new Error('Core provenance evidence contains invalid release identity fields')
  }
  return evidence
}

const coreProvenance = coreProvenancePath ? readCoreProvenance(coreProvenancePath) : undefined

function coreCli(args) {
  const result = spawnQbitRpcSync('bash', [resolve(root, coreCliPath), ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(`qbit Core RPC ${args[0]} failed${detail ? `:\n${detail}` : ''}`)
  }
  return JSON.parse(result.stdout)
}

// The copies keyring-service signs with, checked against the committed pins.
const sdkPackages = checkSdkPackages(root)
if (sdkPackages.errors.length > 0) {
  throw new Error(`SDK packages do not match their pins:\n- ${sdkPackages.errors.join('\n- ')}`)
}
const sdkRequire = createRequire(resolve(root, 'packages/keyring-service/package.json'))
const protocolRoot = dirname(sdkRequire.resolve('@qbit-oss/protocol/package.json'))
const [protocol, pqc, keyringPackage, walletShared] = await Promise.all([
  import(pathToFileURL(resolve(protocolRoot, 'lib/index.mjs')).href),
  import(pathToFileURL(sdkRequire.resolve('@qbit-oss/pqc')).href),
  import(pathToFileURL(resolve(root, 'packages/keyring-service/lib/qbit-hd-keyring.mjs')).href),
  import(pathToFileURL(resolve(root, 'packages/wallet-shared/lib/index.mjs')).href),
])

await pqc.init({
  wasmBinary: readFileSync(sdkRequire.resolve('@qbit-oss/pqc/wasm/pqc.wasm')),
})

const externalKeyring = new keyringPackage.QbitHdKeyring({
  mnemonic: fixedMnemonic,
  activeIndexes: indexes,
  hdPath: "m/87'/1'/0'/0",
})
const internalKeyring = new keyringPackage.QbitHdKeyring({
  mnemonic: fixedMnemonic,
  activeIndexes: indexes,
  hdPath: "m/87'/1'/0'/1",
})
const externalAccounts = await externalKeyring.getQbitAccounts()
const internalAccounts = await internalKeyring.getQbitAccounts()
const descriptors = await externalKeyring.exportP2mrDescriptors('regtest')
const valid = externalAccounts[0].addresses.regtest
const outputScriptLength = protocol.addressToScriptPubKey(valid, 'regtest').length
const leafScriptLength = protocol.hexToBytes(externalAccounts[0].leafScript).length
const controlBlockLength = protocol.buildControlBlock(protocol.P2MR_LEAF_VERSION_V1, []).length
const externalRegtestAddresses = externalAccounts.map(account => account.addresses.regtest)
const internalRegtestAddresses = internalAccounts.map(account => account.addresses.regtest)

let coreEvidence = {
  validated: false,
  requiredAt: 'corepack pnpm test:conformance',
}
if (coreCliPath) {
  const range = JSON.stringify([0, count - 1])
  const coreExternal = coreCli(['deriveaddresses', descriptors.external.descriptor, range])
  const coreInternal = coreCli(['deriveaddresses', descriptors.internal.descriptor, range])
  if (
    !isDeepStrictEqual(coreExternal, externalRegtestAddresses) ||
    !isDeepStrictEqual(coreInternal, internalRegtestAddresses)
  ) {
    throw new Error('Core deriveaddresses output does not match the generated wallet fixture')
  }
  const networkInfo = coreCli(['getnetworkinfo'])
  const expectedSubversion = `/qbit:${coreProvenance.tag.replace(/^v/, '')}/`
  if (networkInfo.subversion !== expectedSubversion) {
    throw new Error(
      `Core subversion mismatch: expected ${expectedSubversion}, got ${networkInfo.subversion}`
    )
  }
  coreEvidence = {
    validated: true,
    validatedRows: ['derivation'],
    sourceBaseline: {
      repository: coreProvenance.repository,
      commit: coreProvenance.commit,
      treeHashAlgorithm: TREE_HASH_ALGORITHM,
    },
    runtimeRelease: Object.fromEntries(
      Object.entries(coreProvenance).filter(([key]) => key !== 'schemaVersion')
    ),
    subversion: networkInfo.subversion,
    liveValidationRequired: [
      'descriptors',
      'addresses',
      'sighash-sign',
      'tx-fees',
      'psbt',
      'message-proof',
    ],
  }
}

const sizing = outputScriptLengths =>
  walletShared.estimateQbitP2mrTransaction({
    inputCount: 1,
    outputScriptLengths,
    leafScriptLength,
    controlBlockLength,
  }).vsize

const fixture = {
  schemaVersion: 1,
  name: 'qbit-core-g2-matrix',
  provenance: {
    kind: coreCliPath ? 'wallet-golden-core-validated' : 'wallet-golden-unvalidated',
    qbitSdkPackages: sdkPackageIdentities(sdkPackages.pins, MATRIX_SDK_PACKAGES),
    coreEvidence,
  },
  generatedBy: coreCliPath
    ? 'scripts/conformance/generate-matrix-fixture.mjs with cryptographically verified Core release provenance'
    : 'offline wallet-only generation; Core validation is required before committing this fixture',
  derivation: {
    count,
    externalPath: "m/87'/1'/0'/0",
    internalPath: "m/87'/1'/0'/1",
    externalRegtestAddresses,
    internalRegtestAddresses,
  },
  descriptors: {
    externalSha256: createHash('sha256').update(descriptors.external.descriptor).digest('hex'),
    internalSha256: createHash('sha256').update(descriptors.internal.descriptor).digest('hex'),
  },
  addresses: {
    invalidRegtest: [
      {
        name: 'checksum-mutation',
        value: `${valid.slice(0, -1)}${valid.endsWith('x') ? 'q' : 'x'}`,
      },
      { name: 'mixed-case', value: `Q${valid.slice(1)}` },
      { name: 'short-program', value: 'qbrt1z2rkskwvnm8' },
      {
        name: 'wrong-checksum-family',
        value: 'qbrt1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sfy8ykg',
      },
      { name: 'wrong-network', value: externalAccounts[0].addresses.mainnet },
    ],
  },
  txFees: {
    leafScriptLength,
    controlBlockLength,
    outputScriptLength,
    singleInputSingleOutputVsize: sizing([outputScriptLength]),
    singleInputTwoOutputVsize: sizing([outputScriptLength, outputScriptLength]),
    explicitSignatureItemVsize: walletShared.estimateQbitP2mrTransaction({
      inputCount: 1,
      outputScriptLengths: [outputScriptLength],
      leafScriptLength,
      controlBlockLength,
      signatureItemLength: walletShared.QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES + 1,
    }).vsize,
    dustBoundarySats: walletShared.QBIT_P2MR_DUST,
  },
}

const fixturePath = resolve(root, 'scripts/conformance/fixtures/matrix.json')
const prettierConfig = (await resolveConfig(fixturePath)) || {}
const serialized = await format(JSON.stringify(fixture), {
  ...prettierConfig,
  filepath: fixturePath,
  parser: 'json',
})
if (outputPath) writeFileSync(resolve(root, outputPath), serialized)
else process.stdout.write(serialized)
