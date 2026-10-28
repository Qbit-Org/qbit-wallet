import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUS_EVENTS,
  BUS_METHODS,
  CHAINS_MAP,
  ErrorCodes,
  PsbtActionDetailType,
  QBIT_MAX_FEE_RATE,
  RiskType,
  QBIT_P2MR_DUST,
  SignMessageType,
  type ToSignData,
  canCreateQbitSendRequest,
  estimateQbitP2mrTransaction,
  getAccountCapabilities,
  KeyringType as SharedKeyringType,
  WalletError,
  qbitMaximumTotalFee,
  statedPsbtRecipients,
} from '@qbit/wallet-shared'
import { QbitApiError } from '@qbit-oss/api'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  SIGHASH_NONE,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtScriptSigField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  outputScriptToAddress,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  qbitDataSigPqcHash,
  qbitWalletMessageHash,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  verifyP2mrMessageProof,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/keyring-service/types'
import { transactionCore } from '@qbit/wallet-core'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import {
  keyringService,
  preferenceService,
  qbitSendGuardService,
  walletApiService,
} from '../src/services'
import { QBIT_WALLET_SEND_CLAIM_ORIGIN } from '../src/services/qbitSendGuards'
import { bgEventBus } from '../src/utils/eventBus'
import { QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS } from '../src/utils/qbit-explorer-fetch'

const sendQbitMock = vi.hoisted(() => vi.fn())
// Every explorer client the wallet builds carries its transport budgets (#353).
const EXPLORER_BUDGETS = {
  timeoutMs: QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
  fetchFn: expect.any(Function),
}
const sendAllQbitMock = vi.hoisted(() => vi.fn())
const signMessageOfBIP322SimpleMock = vi.hoisted(() => vi.fn())
const broadcastTxMock = vi.hoisted(() => vi.fn())
const getFeeTiersMock = vi.hoisted(() => vi.fn())
const getTxMock = vi.hoisted(() => vi.fn())
const getTxHexMock = vi.hoisted(() => vi.fn())
const getTxOutspendsMock = vi.hoisted(() => vi.fn())
const verifyPqcMock = vi.hoisted(() => vi.fn())
const getTxStatusMock = vi.hoisted(() => vi.fn())
const getAddressUtxosMock = vi.hoisted(() => vi.fn())
const getAddressHistoryMock = vi.hoisted(() => vi.fn())
const getAddressMempoolTxsMock = vi.hoisted(() => vi.fn())
const getAddressStatsMock = vi.hoisted(() => vi.fn())
const getTipHashMock = vi.hoisted(() => vi.fn())
const getTipHeightMock = vi.hoisted(() => vi.fn())
const esploraClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    broadcastTx: broadcastTxMock,
    getAddressHistory: getAddressHistoryMock,
    getAddressMempoolTxs: getAddressMempoolTxsMock,
    getAddressStats: getAddressStatsMock,
    getAddressUtxos: getAddressUtxosMock,
    getFeeTiers: getFeeTiersMock,
    getTipHash: getTipHashMock,
    getTipHeight: getTipHeightMock,
    getTx: getTxMock,
    getTxHex: getTxHexMock,
    getTxOutspends: getTxOutspendsMock,
    getTxStatus: getTxStatusMock,
  }))
)
const mempoolQbitClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    broadcastTx: broadcastTxMock,
    getAddressHistory: getAddressHistoryMock,
    getAddressMempoolTxs: getAddressMempoolTxsMock,
    getAddressStats: getAddressStatsMock,
    getAddressUtxos: getAddressUtxosMock,
    getFeeTiers: getFeeTiersMock,
    getTipHash: getTipHashMock,
    getTipHeight: getTipHeightMock,
    getTx: getTxMock,
    getTxHex: getTxHexMock,
    getTxOutspends: getTxOutspendsMock,
    getTxStatus: getTxStatusMock,
  }))
)

vi.mock('@qbit/tx-helpers', async importOriginal => {
  const actual = await importOriginal<typeof import('@qbit/tx-helpers')>()
  return {
    ...actual,
    sendQbit: sendQbitMock,
    sendAllQbit: sendAllQbitMock,
    signMessageOfBIP322Simple: signMessageOfBIP322SimpleMock,
  }
})

vi.mock('@qbit-oss/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@qbit-oss/api')>()
  return {
    ...actual,
    EsploraClient: esploraClientMock,
    MempoolQbitClient: mempoolQbitClientMock,
  }
})

// A deterministic stand-in for SLH-DSA: a signature is bound to the public key
// and the exact sighash, so a changed output, amount or key fails to verify
// just as it would with the real scheme.
vi.mock('@qbit-oss/pqc', () => ({
  verify: verifyPqcMock,
}))

vi.mock('../src/services', () => ({
  keyringService: {
    keyrings: [],
    getAllDisplayedKeyrings: vi.fn(async () => []),
    signMessage: vi.fn(),
    preflightP2mrMessageSigning: vi.fn(),
    preflightP2mrPsbtSigning: vi.fn(),
    signP2mrMessageWithCounter: vi.fn(),
    signP2mrPsbtWithCounter: vi.fn(),
    getQbitRecoveryState: vi.fn(),
    getQbitRecoveryVaultState: vi.fn(),
    replaceQbitRecoveryMigrationPlans: vi.fn(),
    replaceQbitRecoveryMigrationPlansWithDestinationReservations: vi.fn(),
    updateQbitRecoveryMigrationPlan: vi.fn(),
    markQbitRecoveryMigrated: vi.fn(),
    reopenQbitRecoveryMigration: vi.fn(),
    completeQbitRecoveryAddressDiscovery: vi.fn(),
    beginQbitRecoveryMigrationToExistingDestination: vi.fn(),
    createQbitMigrationKeyring: vi.fn(),
    removePreMnemonics: vi.fn(),
    markQbitReceiveIndexesIssued: vi.fn(),
    recordQbitReceiveActivity: vi.fn(),
    addNewAccount: vi.fn(),
    rearmQbitRestoreFloorsForKeyring: vi.fn(),
    restorePqcSignatureCounterFloors: vi.fn(),
    removeKeyring: vi.fn(),
    createTmpKeyring: vi.fn(),
  },
  preferenceService: {
    getCurrentAccount: vi.fn(),
    getAddressFlag: vi.fn(() => 0),
    getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
  },
  qbitSendGuardService: {
    acquireExternalSigningLock: vi.fn(),
    assertNoOverlap: vi.fn(),
    broadcastIfAllowed: vi.fn(),
    getReservedOutpointKeys: vi.fn(async () => new Set()),
    hasDependentSpend: vi.fn(async () => false),
    promoteExternalSigningLockToBroadcastClaim: vi.fn(),
    recordInconclusiveBroadcast: vi.fn(),
    releaseBroadcastClaim: vi.fn(),
    releaseExternalSigningLock: vi.fn(),
    runWithBroadcastClaim: vi.fn(),
    runWithNoOverlap: vi.fn(),
    runWithProviderBroadcastClaim: vi.fn(),
    settleRecentSpendProbe: vi.fn(),
    takeRecentSpendersToProbe: vi.fn(async () => []),
  },
  // The centralized asset lookup is intentionally absent: Qbit flows must
  // never call that unsupported surface, and a regression would crash here
  // instead of silently resolving.
  walletApiService: {
    transactionCore: {
      pushTx: vi.fn(),
      decodePsbt: vi.fn(),
    },
  },
  sessionService: {},
  contactBookService: {},
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

function p2mrAccount(pubkeyHex = '11'.repeat(32), derivationIndex = 0) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address: p2mrAddressFromPubkey(pubkey, 'regtest'),
    key: 'account-0',
    flag: 0,
    index: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: `m/87'/1'/0'/0/${derivationIndex}`,
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal',
        provenance: 'local',
      },
    },
  }
}

function recipientAddress() {
  return p2mrAddressFromPubkey(hexToBytes('22'.repeat(32)), 'regtest')
}

function recipientAddressScript() {
  return bytesToHex(
    p2mrScriptPubKey(
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes('22'.repeat(32))))
    )
  )
}

function reverseTxid(txid: string) {
  return bytesToHex(new Uint8Array(hexToBytes(txid)).reverse())
}

/** The txid an unsigned P2MR PSBT will broadcast under; signatures do not change it. */
function unsignedTxid(psbtHex: string) {
  const psbt = parsePsbt(hexToBytes(psbtHex))
  const unsigned = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === 0)!.value
  return Buffer.from(transactionCore.crypto.hash256(Buffer.from(unsigned)))
    .reverse()
    .toString('hex')
}

function fakePqcSignature(pubkey: Uint8Array, sighash: Uint8Array): Uint8Array {
  const digest = createHash('sha256').update(pubkey).update(sighash).digest()
  const signature = new Uint8Array(PQC_SIGNATURE_BYTES)
  for (let offset = 0; offset < signature.length; offset += digest.length) {
    signature.set(digest.subarray(0, signature.length - offset), offset)
  }
  return signature
}

function fakePqcVerify(pubkey: Uint8Array, sighash: Uint8Array, signature: Uint8Array) {
  return Buffer.from(signature).equals(Buffer.from(fakePqcSignature(pubkey, sighash)))
}

/** Raw transactions the mocked explorer serves from `/tx/:txid/hex`, by txid. */
const rawTransactions = new Map<string, string>()

/**
 * Signs every input of an unsigned P2MR PSBT with the key in its leaf script,
 * as the wallet would before broadcasting, and returns the raw transaction.
 */
function signedRawTransaction(
  psbtHex: string,
  {
    sign = fakePqcSignature,
    hashType,
    restrictedOutputMode,
  }: { sign?: typeof fakePqcSignature; hashType?: number; restrictedOutputMode?: false } = {}
) {
  const psbt = parsePsbt(hexToBytes(psbtHex))
  const keys = decodePsbt(psbt).inputs.map((input, inputIndex) => {
    const leaf = input.leafScripts[0]!
    return {
      inputIndex,
      pubkey: leaf.script.slice(1, 33),
      leafHash: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leaf.script),
      ...(hashType === undefined ? {} : { hashType }),
    }
  })
  const signed = signP2mrPsbt({
    psbt,
    keys,
    sign: (sighash, { pubkey }) => sign(pubkey, sighash),
    // Only to build the originals these tests refuse.
    allowNonDefaultSighash: hashType !== undefined,
    ...(restrictedOutputMode === undefined ? {} : { restrictedOutputMode }),
  })
  return bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt)))
}

/**
 * The explorer's view of a pending original: its JSON, with the signed raw
 * transaction served under the same txid unless `rawHex` overrides it.
 */
function liveTransactionFromPsbt(
  psbtHex: string,
  { confirmed = false, rawHex }: { confirmed?: boolean; rawHex?: string } = {}
) {
  const txid = unsignedTxid(psbtHex)
  rawTransactions.set(txid, rawHex ?? signedRawTransaction(psbtHex))
  const summary = decodePsbt(parsePsbt(hexToBytes(psbtHex)))
  const leaf = summary.inputs[0]!.leafScripts[0]!
  const size = estimateQbitP2mrTransaction({
    inputCount: summary.inputs.length,
    outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
    leafScriptLength: leaf.script.length,
    controlBlockLength: leaf.controlBlock.length,
  }).vsize

  return {
    txid,
    version: 2,
    locktime: 0,
    vin: summary.inputs.map(input => ({
      txid: reverseTxid(bytesToHex(input.prevout.txid)),
      vout: input.prevout.vout,
      prevout: {
        scriptpubkey: bytesToHex(input.witnessUtxo!.scriptPubKey),
        scriptpubkey_asm: '',
        scriptpubkey_type: 'v1_p2mr',
        value: Number(input.witnessUtxo!.value),
      },
      scriptsig: '',
      scriptsig_asm: '',
      witness: [],
      is_coinbase: false,
      sequence: input.sequence,
    })),
    vout: summary.outputs.map(output => ({
      scriptpubkey: bytesToHex(output.scriptPubKey),
      scriptpubkey_asm: '',
      scriptpubkey_type: output.scriptPubKey[0] === 0x6a ? 'op_return' : 'v1_p2mr',
      value: Number(output.value),
    })),
    size,
    weight: size,
    fee: Number(summary.fee),
    status: confirmed ? { confirmed: true, block_height: 10 } : { confirmed: false },
  }
}

const SIGNATURE_BUDGET = {
  required: 1,
  cached: 0,
  remainingBefore: 30,
  remainingAfter: 29,
  limit: 30,
}

function expectPreviewToMatchFinalizedTransaction(toSignData: ToSignData) {
  const psbt = parsePsbt(hexToBytes(toSignData.psbtHex))
  const summary = decodePsbt(psbt)
  const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
    inputIndex: key.inputIndex,
    pubkey: hexToBytes(key.publicKey),
    leafHash: hexToBytes(key.leafHash),
  }))
  const signed = signP2mrPsbt({
    psbt,
    keys,
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
  })
  const rawTransaction = extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt))
  const leaf = summary.inputs[0]!.leafScripts[0]!
  const exact = estimateQbitP2mrTransaction({
    inputCount: summary.inputs.length,
    outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
    leafScriptLength: leaf.script.length,
    controlBlockLength: leaf.controlBlock.length,
  })

  expect(toSignData.estimatedFee).toBe(Number(summary.fee))
  expect(toSignData.estimatedVsize).toBe(rawTransaction.length)
  expect(toSignData.estimatedVsize).toBe(exact.vsize)
}

function psbtHexWithDataOutputs(
  account: ReturnType<typeof p2mrAccount>,
  scripts: Uint8Array[],
  inputTxids = ['98'.repeat(32)],
  inputAccounts: ReturnType<typeof p2mrAccount>[] = []
) {
  const recipientPubkey = hexToBytes('22'.repeat(32))
  const recipientLeafScript = singleKeyLeafScript(recipientPubkey)
  const recipientLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, recipientLeafScript)
  const psbt = createP2mrPsbt({
    inputs: inputTxids.map((txid, inputIndex) => {
      const inputAccount = inputAccounts[inputIndex] || account
      const leafScript = singleKeyLeafScript(hexToBytes(inputAccount.pubkey))
      const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
      return {
        prevout: { txid: hexToBytes(txid), vout: 0 },
        witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      }
    }),
    outputs: [
      { value: 10_000n, scriptPubKey: p2mrScriptPubKey(recipientLeafHash) },
      ...scripts.map(scriptPubKey => ({ value: 0n, scriptPubKey })),
    ],
  })
  return bytesToHex(serializePsbt(psbt))
}

function quietAddressStats(address: string, mempoolSpentCount = 0) {
  return {
    address,
    chain_stats: {
      funded_txo_count: 2,
      funded_txo_sum: 100_000,
      spent_txo_count: 1,
      spent_txo_sum: 50_000,
      tx_count: 2,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: mempoolSpentCount,
      spent_txo_sum: mempoolSpentCount > 0 ? 50_000 : 0,
      tx_count: mempoolSpentCount > 0 ? 1 : 0,
    },
  }
}

/**
 * The controller reads the per-network v2 vault shape; tests keep working
 * with the flat single-network record and wrap it under the regtest key at
 * the mock boundary.
 */
function wrapRegtestVaultState(flat: any) {
  return {
    version: 2 as const,
    acknowledgement: flat.acknowledgement ?? 'required',
    networks: {
      mainnet: { status: 'seed-only-restored' as const, addressDiscoveryComplete: false },
      testnet4: { status: 'seed-only-restored' as const, addressDiscoveryComplete: false },
      regtest: {
        status: flat.status,
        addressDiscoveryComplete: flat.addressDiscoveryComplete === true,
        ...(flat.migration ? { migration: flat.migration } : {}),
      },
    },
  }
}

/**
 * Raw destination keyring the controller re-derives plan destinations from.
 * Index 0 is the recorded anchor; deeper indexes derive deterministic
 * accounts for structure-preserving sweeps.
 */
function installQbitDestinationRawKeyring(
  anchorAccount: ReturnType<typeof p2mrAccount>,
  keyringIndex = 3
) {
  const activeIndexes = [0]
  const receiveIssuedIndexes: number[] = []
  const accountForIndex = (index: number) =>
    index === 0 ? anchorAccount : p2mrAccount((0x50 + index).toString(16).repeat(32))
  const rawKeyring = {
    type: KeyringType.QbitHdKeyring,
    activeIndexes,
    receiveIssuedIndexes,
    getAccounts: vi.fn(async () => activeIndexes.map(index => accountForIndex(index).pubkey)),
    getQbitReceiveAccount: vi.fn(async (index: number) => {
      const account = accountForIndex(index)
      return { index, pubkey: account.pubkey, addresses: account.p2mr.addresses }
    }),
    getQbitReceiveState: vi.fn(() => ({
      currentIndex: null,
      issuedIndexes: [...receiveIssuedIndexes],
      usedIndexes: [],
    })),
  }
  ;(keyringService as any).keyrings[keyringIndex] = rawKeyring
  return rawKeyring
}

function qbitRecoveryMigrationFixture() {
  const sourceAccount = p2mrAccount('41'.repeat(32))
  const destinationAccount = p2mrAccount('22'.repeat(32))
  const sourceTxid = '98'.repeat(32)
  const psbtHex = psbtHexWithDataOutputs(sourceAccount, [])
  const plan = {
    id: `${sourceAccount.pubkey}:0`,
    sourcePubkey: sourceAccount.pubkey,
    sourceAddress: sourceAccount.address,
    destinationAddress: destinationAccount.address,
    amount: 10_000,
    fee: 40_000,
    psbtHex,
    status: 'broadcast' as const,
    signedPsbtHex: psbtHex,
    txid: '62'.repeat(32),
  }
  const sourceKeyring = {
    index: 2,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    accounts: [sourceAccount],
  }
  const destinationKeyring = {
    index: 3,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    accounts: [destinationAccount],
  }
  const vaultState = {
    version: 1 as const,
    status: 'migrating' as const,
    acknowledgement: 'accepted' as const,
    addressDiscoveryComplete: true,
    migration: {
      destinationKeyringIndex: 3,
      destinationPubkey: destinationAccount.pubkey,
      destinationAddress: destinationAccount.address,
      network: 'regtest' as const,
      plans: [plan],
    },
  }
  const publicState = (state: typeof vaultState) => ({
    status: state.status,
    acknowledgement: state.acknowledgement,
    counterConfidence: 'chain-floor-only' as const,
    knownOnChainSignatures: 4,
    migration: {
      destinationKeyringIndex: state.migration.destinationKeyringIndex,
      destinationAddress: state.migration.destinationAddress,
      network: state.migration.network,
      plans: state.migration.plans.map((candidate: any) => ({
        id: candidate.id,
        sourceAddress: candidate.sourceAddress,
        destinationAddress: candidate.destinationAddress,
        amount: candidate.amount,
        fee: candidate.fee,
        status: candidate.status,
        txid: candidate.txid,
        ...(candidate.sourceIndex !== undefined ? { sourceIndex: candidate.sourceIndex } : {}),
        ...(candidate.destinationIndex !== undefined
          ? { destinationIndex: candidate.destinationIndex }
          : {}),
      })),
    },
  })
  const destinationRawKeyring = installQbitDestinationRawKeyring(destinationAccount)
  return {
    sourceAccount,
    destinationAccount,
    sourceKeyring,
    destinationKeyring,
    destinationRawKeyring,
    sourceTxid,
    vaultState,
    publicState,
  }
}

describe('WalletController qbit P2MR send path', () => {
  const originalRegtestQbitApiSurface = CHAINS_MAP[ChainType.QBIT_REGTEST]?.qbitApiSurface

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set()
    )
    vi.mocked(qbitSendGuardService.takeRecentSpendersToProbe).mockResolvedValue([])
    vi.mocked(qbitSendGuardService.hasDependentSpend).mockResolvedValue(false)
    vi.mocked(qbitSendGuardService.releaseExternalSigningLock).mockResolvedValue(true)
    vi.mocked(
      qbitSendGuardService.promoteExternalSigningLockToBroadcastClaim
    ).mockResolvedValue(undefined)
    vi.mocked(qbitSendGuardService.runWithBroadcastClaim).mockImplementation(
      async (_claim, operation) => operation()
    )
    vi.mocked(qbitSendGuardService.runWithProviderBroadcastClaim).mockImplementation(
      async (_claim, operation) => operation()
    )
    vi.mocked(qbitSendGuardService.runWithNoOverlap).mockImplementation(
      async (_chain, _outpoints, operation) => operation()
    )
    vi.mocked(qbitSendGuardService.broadcastIfAllowed).mockImplementation(
      async (_chain, _txid, _outpoints, broadcast) => broadcast()
    )
    vi.mocked(walletApiService.transactionCore.pushTx).mockResolvedValue('service-txid')
    vi.mocked(keyringService.preflightP2mrMessageSigning).mockResolvedValue(SIGNATURE_BUDGET)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(SIGNATURE_BUDGET)
    broadcastTxMock.mockResolvedValue('qbit-txid')
    getTxStatusMock.mockResolvedValue({ confirmed: false })
    rawTransactions.clear()
    verifyPqcMock.mockReset().mockImplementation(fakePqcVerify)
    getTxHexMock.mockReset().mockImplementation(async (txid: string) => {
      const rawHex = rawTransactions.get(txid)
      if (rawHex === undefined) {
        throw new QbitApiError('not_found', 'transaction not found', { status: 404 })
      }
      return rawHex
    })
    // Nothing spends an original's outputs unless a test says so.
    getTxOutspendsMock.mockReset().mockImplementation(async (txid: string) => {
      const rawHex = rawTransactions.get(txid)
      if (rawHex === undefined) {
        throw new QbitApiError('not_found', 'transaction not found', { status: 404 })
      }
      return transactionCore.Transaction.fromHex(rawHex).outs.map(() => ({ spent: false }))
    })
    getFeeTiersMock.mockResolvedValue([
      { target: 20, feeRate: 1 },
      { target: 6, feeRate: 3 },
      { target: 2, feeRate: 9 },
    ])
    getAddressHistoryMock.mockReset()
    getAddressMempoolTxsMock.mockReset().mockResolvedValue([])
    getAddressStatsMock.mockReset().mockImplementation(async address => quietAddressStats(address))
    getTipHashMock.mockReset().mockResolvedValue('ab'.repeat(32))
  })

  afterEach(() => {
    CHAINS_MAP[ChainType.QBIT_REGTEST]!.qbitApiSurface = originalRegtestQbitApiSurface
    // Raw keyrings installed for migration destinations must not leak between
    // tests: a stale entry would satisfy another test's destination lookup.
    ;(keyringService as any).keyrings.length = 0
  })

  it('builds a qbit P2MR PSBT instead of falling back to sendQbit', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const txid = 'aa'.repeat(32)

    const result = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      enableRBF: true,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid,
          vout: 1,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    expect(sendQbitMock).not.toHaveBeenCalled()
    expect(result.toSignInputs).toEqual([{ index: 0, publicKey: account.pubkey }])
    expect(result.qbitP2mrSigningKeys).toEqual([
      {
        inputIndex: 0,
        publicKey: account.pubkey,
        leafHash: bytesToHex(
          p2mrLeafHash(P2MR_LEAF_VERSION_V1, hexToBytes(account.p2mr.leafScript))
        ),
      },
    ])

    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.inputs[0]!.prevout.vout).toBe(1)
    expect(bytesToHex(summary.inputs[0]!.prevout.txid)).toBe(reverseTxid(txid))
    expect(summary.inputs[0]!.sequence).toBe(0xfffffffd)
    expect(summary.outputs[0]!.value).toBe(10_000n)
    expect(outputScriptToAddress(summary.outputs[0]!.scriptPubKey, 'regtest')).toBe(
      recipientAddress()
    )
    // qbit has no witness discount. A finalized default-sighash transaction
    // with one input and two 34-byte P2MR outputs is exactly 3,860 vbytes.
    expect(result).toMatchObject({
      estimatedFee: 3_860,
      estimatedVsize: 3_860,
      inputCount: 1,
      changeDroppedSats: 0,
      inputsDominateFee: true,
      maximumTotalFee: 38_600_000,
    })
    // The network and expected txid are fixed with the inputs, before the
    // request reaches approval, so signing and broadcast can be bound to them.
    expect(result.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(result.psbtHex),
    })

    const decoded = await wallet.decodePsbt(result.psbtHex, 'https://example.test')
    expect(decoded.inputInfos[0]).toMatchObject({
      txid,
      vout: 1,
      sequence: 0xfffffffd,
      value: 50_000,
      witnessUtxoScriptHex: account.p2mr.scriptPubKey,
    })
    expect(decoded.outputInfos[0]).toMatchObject({
      address: recipientAddress(),
      value: 10_000,
      scriptPubKeyHex: bytesToHex(summary.outputs[0]!.scriptPubKey),
    })
    expect(decoded.outputInfos[0]!.type).not.toBe('op_return')
  })

  describe('spend summary of a reviewed PSBT (#271)', () => {
    async function buildSend(
      wallet: WalletController,
      account: ReturnType<typeof p2mrAccount>,
      { to = recipientAddress(), feeRate = 1 }: { to?: string; feeRate?: number } = {}
    ) {
      return wallet.createSendQbitPsbt({
        to,
        amount: 100_000,
        feeRate,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [
          {
            txid: '5a'.repeat(32),
            vout: 0,
            satoshis: 10_000_000,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
    }

    it('reports what leaves the wallet from the exact bytes, with change excluded', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const send = await buildSend(wallet, account)

      const decoded = await wallet.decodePsbt(send.psbtHex, 'https://example.test', {
        statedRecipients: [recipientAddress()],
      })

      expect(decoded.fee).toBe(3_860)
      expect(decoded.spendSummary).toEqual({
        account: account.address,
        walletInputValue: 10_000_000,
        walletOutputValue: 10_000_000 - 100_000 - 3_860,
        netSpend: 103_860,
        externalOutputValue: 100_000,
        outputRoles: ['recipient', 'wallet'],
        unrecognisedOutputCount: 0,
        unrecognisedOutputValue: 0,
        undecodableOutputCount: 0,
        // The regtest quote's fastest tier is 9 bits/vB.
        feeAssessment: {
          fee: 3_860,
          feeRate: 1,
          amount: 100_000,
          recommendedFeeRate: 9,
          reasons: [],
        },
      })
      expect(decoded.risks).toEqual([])
      expect(decoded.shouldWarnFeeRate).toBe(false)
      expect(decoded.recommendedFeeRate).toBe(9)
    })

    it('flags a 400x fee and gates signing on it, with or without a live quote', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const send = await buildSend(wallet, account, { feeRate: 400 })

      const decoded = await wallet.decodePsbt(send.psbtHex, 'https://example.test', {
        statedRecipients: [recipientAddress()],
      })
      expect(decoded.fee).toBe(1_544_000)
      expect(decoded.spendSummary.netSpend).toBe(1_644_000)
      expect(decoded.spendSummary.feeAssessment?.reasons).toEqual([
        'above_recommended_rate',
        'above_relay_floor',
        'large_share_of_amount',
      ])
      expect(decoded.shouldWarnFeeRate).toBe(true)
      expect(decoded.risks.map(risk => [risk.type, risk.level])).toEqual([
        [RiskType.HIGH_FEE_RATE, 'warning'],
      ])

      // A failed quote leaves no recommendation, which the summary records,
      // and the wallet's own bound still flags the rate.
      getFeeTiersMock.mockRejectedValue(new Error('offline'))
      const unquoted = await new WalletController().decodePsbt(
        send.psbtHex,
        'https://example.test',
        { statedRecipients: [recipientAddress()] }
      )
      expect(unquoted.spendSummary.feeAssessment?.recommendedFeeRate).toBeUndefined()
      expect(unquoted.spendSummary.feeAssessment?.reasons).toEqual([
        'above_relay_floor',
        'large_share_of_amount',
      ])
      expect(unquoted.risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
    })

    it('flags a payee the request does not name and treats the wallet’s other accounts as its own', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      const otherAccount = { ...p2mrAccount('33'.repeat(32), 1), key: 'account-1' }
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account, otherAccount] as any)

      const toStranger = await buildSend(wallet, account)
      const unnamed = await wallet.decodePsbt(toStranger.psbtHex, 'https://example.test')
      expect(unnamed.spendSummary.outputRoles).toEqual(['unrecognised', 'wallet'])
      expect(unnamed.spendSummary.unrecognisedOutputValue).toBe(100_000)
      expect(unnamed.risks).toEqual([])

      const misnamed = await wallet.decodePsbt(toStranger.psbtHex, 'https://example.test', {
        statedRecipients: [otherAccount.address],
      })
      expect(misnamed.risks.map(risk => [risk.type, risk.level])).toEqual([
        [RiskType.UNRECOGNISED_OUTPUT, 'danger'],
      ])

      const toOwnAccount = await buildSend(wallet, account, { to: otherAccount.address })
      const own = await wallet.decodePsbt(toOwnAccount.psbtHex, 'https://example.test')
      expect(own.spendSummary.outputRoles).toEqual(['wallet', 'wallet'])
      // Only the fee leaves the wallet.
      expect(own.spendSummary.netSpend).toBe(3_860)
      expect(own.risks).toEqual([])
    })

    it('refuses a summary when the account changes while the decode reads the quote', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      const otherAccount = { ...p2mrAccount('33'.repeat(32), 1), key: 'account-1' }
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const send = await buildSend(wallet, account)

      getFeeTiersMock.mockImplementationOnce(async () => {
        vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)
        return [{ target: 2, feeRate: 1 }]
      })
      await expect(wallet.decodePsbt(send.psbtHex, 'https://example.test')).rejects.toThrow(
        'Invalid qbit P2MR PSBT'
      )

      // Decoded again for the account now current, the same bytes spend
      // nothing of its own.
      const decoded = await wallet.decodePsbt(send.psbtHex, 'https://example.test')
      expect(decoded.spendSummary.account).toBe(otherAccount.address)
      expect(decoded.spendSummary.walletInputValue).toBe(0)
      expect(decoded.spendSummary.netSpend).toBe(0)
    })
  })

  describe('quick multi-sign of a local batch (#367)', () => {
    async function buildSend(
      wallet: WalletController,
      account: ReturnType<typeof p2mrAccount>,
      { feeRate = 1, txidByte = '5b' }: { feeRate?: number; txidByte?: string } = {}
    ) {
      return wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 100_000,
        feeRate,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [
          {
            txid: txidByte.repeat(32),
            vout: 0,
            satoshis: 10_000_000,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
    }

    /** The same send, but its request names another recipient than the one it pays. */
    function misnamed(toSignData: ToSignData, namedRecipient: string): ToSignData {
      return {
        ...toSignData,
        action: {
          ...toSignData.action!,
          details: toSignData.action!.details!.map(detail =>
            detail.type === PsbtActionDetailType.ADDRESS
              ? { ...detail, value: namedRecipient }
              : detail
          ),
        },
      }
    }

    /** A local batch: a normal send, a 400x fee and an output the request does not name. */
    async function buildBatch(wallet: WalletController, account: ReturnType<typeof p2mrAccount>) {
      const stranger = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'regtest')
      return [
        await buildSend(wallet, account, { txidByte: '5b' }),
        await buildSend(wallet, account, { feeRate: 400, txidByte: '5c' }),
        misnamed(await buildSend(wallet, account, { txidByte: '5d' }), stranger),
      ]
    }

    function mockSigning() {
      vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
        async (_address, { psbt, keys }) => {
          const signed = signP2mrPsbt({
            psbt,
            keys,
            sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
          })
          return { psbt: signed.psbt, signed: signed.signed, counterResults: [] }
        }
      )
    }

    it('reviews each PSBT of the batch from its exact bytes and flags a 400x fee and an unrecognised output', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const batch = await buildBatch(wallet, account)

      const summary = await wallet.analyzeLocalPsbts(batch)

      expect(summary.account).toBe(account.address)
      expect(summary.chain).toBe(ChainType.QBIT_REGTEST)
      expect(summary.parseErrorCount).toBe(0)
      expect(summary.items.map(item => item.risks.map(risk => [risk.type, risk.level]))).toEqual([
        [],
        [[RiskType.HIGH_FEE_RATE, 'warning']],
        [[RiskType.UNRECOGNISED_OUTPUT, 'danger']],
      ])
      // The same summary and risks a review of each PSBT on its own shows.
      for (const [index, toSignData] of batch.entries()) {
        const decoded = await wallet.decodePsbt(toSignData.psbtHex, '', {
          statedRecipients: statedPsbtRecipients(toSignData),
        })
        expect(summary.items[index]!.risks).toEqual(decoded.risks)
        expect(summary.items[index]!.spendSummary).toEqual(decoded.spendSummary)
      }
      expect(summary.items[1]).toMatchObject({ fee: 1_544_000, feeRate: '400.00' })
      expect(summary.items[1]!.spendSummary!.feeAssessment!.reasons).toContain('above_relay_floor')
      expect(summary.items[2]!.spendSummary!.outputRoles).toEqual(['unrecognised', 'wallet'])
    })

    it('signs a flagged PSBT of the batch only with its risks explicitly confirmed', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
      mockSigning()
      const [clean, highFee, unrecognised] = await buildBatch(wallet, account)
      const { account: reviewedAccount, chain } = await wallet.analyzeLocalPsbts([
        clean!,
        highFee!,
        unrecognised!,
      ])
      const review = (confirmedRisks: RiskType[]) => ({
        account: reviewedAccount,
        chain,
        confirmedRisks,
      })

      await expect(wallet.signLocalBatchPsbt(highFee!, review([]))).rejects.toThrow(
        'risk that was not confirmed'
      )
      await expect(
        wallet.signLocalBatchPsbt(highFee!, review([RiskType.UNRECOGNISED_OUTPUT]))
      ).rejects.toThrow('risk that was not confirmed')
      await expect(wallet.signLocalBatchPsbt(unrecognised!, review([]))).rejects.toThrow(
        'risk that was not confirmed'
      )
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()

      const signedHighFee = await wallet.signLocalBatchPsbt(
        highFee!,
        review([RiskType.HIGH_FEE_RATE])
      )
      const signedUnrecognised = await wallet.signLocalBatchPsbt(
        unrecognised!,
        review([RiskType.UNRECOGNISED_OUTPUT])
      )
      const signedClean = await wallet.signLocalBatchPsbt(clean!, review([]))

      expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(3)
      for (const signed of [signedHighFee, signedUnrecognised, signedClean]) {
        expect(decodePsbt(parsePsbt(hexToBytes(signed.psbtHex!))).inputs[0]!.finalized).toBe(true)
      }
      expect(signedHighFee.qbitBroadcastIdentity).toEqual(highFee!.qbitBroadcastIdentity)
    })

    it('refuses a batch PSBT once the account or network differs from the one it was analyzed for', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      const otherAccount = { ...p2mrAccount('33'.repeat(32), 1), key: 'account-1' }
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
      mockSigning()
      const [clean] = await buildBatch(wallet, account)
      const summary = await wallet.analyzeLocalPsbts([clean!])
      const review = { account: summary.account, chain: summary.chain, confirmedRisks: [] }

      // Another account is current when signing starts.
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)
      await expect(wallet.signLocalBatchPsbt(clean!, review)).rejects.toThrow(
        'changed after the batch was reviewed'
      )

      // The account switches while signing re-reads the wallet's accounts.
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      vi.spyOn(wallet, 'getAccounts').mockImplementationOnce(async () => {
        vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)
        return []
      })
      await expect(wallet.signLocalBatchPsbt(clean!, review)).rejects.toThrow('account changed')

      // Same account, another network.
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      await expect(
        wallet.signLocalBatchPsbt(clean!, { ...review, chain: ChainType.QBIT_TESTNET4 })
      ).rejects.toThrow('changed after the batch was reviewed')
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()

      await expect(wallet.signLocalBatchPsbt(clean!, review)).resolves.toMatchObject({
        qbitBroadcastIdentity: clean!.qbitBroadcastIdentity,
      })
    })

    it('refuses an analysis when the account changes while it is read, and any provider request', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      const otherAccount = { ...p2mrAccount('33'.repeat(32), 1), key: 'account-1' }
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const [clean] = await buildBatch(wallet, account)

      vi.spyOn(wallet, 'getAccounts').mockImplementationOnce(async () => {
        vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)
        return []
      })
      await expect(wallet.analyzeLocalPsbts([clean!])).rejects.toThrow('account changed')

      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      await expect(
        wallet.signLocalBatchPsbt(
          { ...clean!, providerContext: { origin: 'https://dapp.example' } as any },
          { account: account.address, chain: ChainType.QBIT_REGTEST, confirmedRisks: [] }
        )
      ).rejects.toThrow('A provider request is signed one transaction at a time')
      await expect(
        wallet.signLocalBatchPsbt(
          { ...clean!, qbitRecoveryMigration: { planId: 'plan' } as any },
          { account: account.address, chain: ChainType.QBIT_REGTEST, confirmedRisks: [] }
        )
      ).rejects.toThrow('A recovery migration is signed from its own review')
      await expect(
        wallet.signLocalBatchPsbt(clean!, { account: account.address } as any)
      ).rejects.toThrow('invalid batch review')
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    })

    it('refuses a critical risk however it is confirmed', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      mockSigning()
      const [clean] = await buildBatch(wallet, account)
      const review = (wallet as any).reviewQbitP2mrPsbt
      vi.spyOn(wallet as any, 'reviewQbitP2mrPsbt').mockImplementation((...args: unknown[]) => {
        const decoded = review(...args)
        return {
          ...decoded,
          risks: [{ type: RiskType.SCAMMER_ADDRESS, level: 'critical', title: '', desc: '' }],
        }
      })

      await expect(
        wallet.signLocalBatchPsbt(clean!, {
          account: account.address,
          chain: ChainType.QBIT_REGTEST,
          confirmedRisks: [RiskType.SCAMMER_ADDRESS],
        })
      ).rejects.toThrow('a risk that cannot be confirmed')
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    })
  })

  it('keeps previewed fee and size exact across change, no-change, memo, multi-input, and send-all', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxo = (txidByte: string, satoshis: number, vout = 0) => ({
      txid: txidByte.repeat(32),
      vout,
      satoshis,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    })

    const previews = [
      await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [utxo('41', 50_000)],
      }),
      await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 6_000,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [utxo('42', 10_000)],
      }),
      await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 1,
        memo: 'exact memo',
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [utxo('43', 50_000)],
      }),
      // Neither output covers the amount alone, so both are spent.
      await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 60_000,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [utxo('44', 30_000), utxo('45', 50_000, 1)],
      }),
      await wallet.createSendAllQbitPsbt({
        to: recipientAddress(),
        feeRate: 1,
        memo: 'send all',
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [utxo('46', 30_000), utxo('47', 30_000, 1)],
      }),
    ]

    previews.forEach(expectPreviewToMatchFinalizedTransaction)
    previews.forEach(preview =>
      expect(preview.qbitBroadcastIdentity).toEqual({
        chain: ChainType.QBIT_REGTEST,
        txid: unsignedTxid(preview.psbtHex),
      })
    )
    expect(previews[1]).toMatchObject({
      estimatedFee: 4_000,
      changeDroppedSats: 183,
    })
    expect(previews[3]?.inputCount).toBe(2)
  })

  it('projects a readonly signature budget and acquires its exact send lock before approval', async () => {
    const wallet = new WalletController()
    const account = { ...p2mrAccount(), type: KeyringType.ReadonlyKeyring }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'a9'.repeat(32),
          vout: 2,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const providerContext = {
      origin: 'https://otc.example',
      account: 'qbrt1zprovider-context-differs',
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }
    toSignData.providerContext = providerContext
    toSignData.qbitSendBroadcastClaim = wallet.createQbitSendBroadcastClaim(
      toSignData.psbtHex,
      providerContext
    )
    vi.mocked(qbitSendGuardService.acquireExternalSigningLock).mockImplementationOnce(
      async identity => ({ ...identity, id: 'external-lock-1' })
    )

    const lock = await wallet.acquireExternalQbitSigningLock([toSignData], 'send')

    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    expect(toSignData.signatureBudget).toEqual({
      required: 1,
      cached: 0,
      remainingBefore: account.p2mr.signatureCounter.remaining,
      remainingAfter: account.p2mr.signatureCounter.remaining - 1,
      limit: account.p2mr.signatureCounter.limit,
    })
    expect(qbitSendGuardService.acquireExternalSigningLock).toHaveBeenCalledWith({
      purpose: 'send',
      chain: ChainType.QBIT_REGTEST,
      address: account.address,
      origin: providerContext.origin,
      entries: [
        {
          txid: toSignData.qbitSendBroadcastClaim.txid,
          outpoints: toSignData.qbitSendBroadcastClaim.outpoints,
        },
      ],
    })
    expect(lock).toMatchObject({
      id: 'external-lock-1',
      address: account.address,
      origin: providerContext.origin,
    })
    await expect(wallet.completeExternalQbitSigningLock(lock!)).resolves.toBeUndefined()
    expect(qbitSendGuardService.releaseExternalSigningLock).toHaveBeenCalledWith(lock)
  })

  it('excludes reserved outpoints from explicit qbit coin selection', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const reservedTxid = 'aa'.repeat(32)
    const availableTxid = 'bb'.repeat(32)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set([`${reservedTxid}:0`])
    )

    const result = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [reservedTxid, availableTxid].map(txid => ({
        txid,
        vout: 0,
        satoshis: 50_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      })),
    })

    const [input] = decodePsbt(parsePsbt(hexToBytes(result.psbtHex))).inputs
    expect(input?.prevout.txid).toEqual(hexToBytes(reverseTxid(availableTxid)))
  })

  it('builds a live-verified replacement that preserves recipients, memo bytes, inputs and intent', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const original = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      memo: 'fee bump memo',
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '31'.repeat(32),
          vout: 2,
          satoshis: 100_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const live = liveTransactionFromPsbt(original.psbtHex)
    getTxMock.mockResolvedValue(live)

    const eligibility = await wallet.getQbitFeeBumpEligibility(live.txid)
    expect(eligibility).toMatchObject({
      eligible: true,
      originalTxid: live.txid,
      originalFee: original.estimatedFee,
      changeDropped: false,
    })

    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockClear()
    const replacement = await wallet.createBumpFeeQbitPsbt({ txid: live.txid })
    const originalSummary = decodePsbt(parsePsbt(hexToBytes(original.psbtHex)))
    const replacementSummary = decodePsbt(parsePsbt(hexToBytes(replacement.psbtHex)))

    expect(
      replacementSummary.inputs.map(input => ({
        txid: bytesToHex(input.prevout.txid),
        vout: input.prevout.vout,
        sequence: input.sequence,
      }))
    ).toEqual(
      originalSummary.inputs.map(input => ({
        txid: bytesToHex(input.prevout.txid),
        vout: input.prevout.vout,
        sequence: input.sequence,
      }))
    )
    expect(
      replacementSummary.outputs.slice(0, -1).map(output => ({
        value: output.value,
        script: bytesToHex(output.scriptPubKey),
      }))
    ).toEqual(
      originalSummary.outputs.slice(0, -1).map(output => ({
        value: output.value,
        script: bytesToHex(output.scriptPubKey),
      }))
    )
    expect(bytesToHex(replacementSummary.outputs[1]!.scriptPubKey)).toBe(
      bytesToHex(originalSummary.outputs[1]!.scriptPubKey)
    )
    expect(replacementSummary.outputs.at(-1)!.scriptPubKey).toEqual(
      originalSummary.outputs.at(-1)!.scriptPubKey
    )
    expect(replacementSummary.outputs.at(-1)!.value).toBeLessThan(
      originalSummary.outputs.at(-1)!.value
    )

    expect(replacement.feeBump).toMatchObject({
      originalFee: original.estimatedFee,
      replacementFee: replacement.estimatedFee,
      feeDelta: replacement.estimatedFee! - original.estimatedFee!,
      changeDropped: false,
    })
    expect(replacement.feeBump!.replacementFee).toBeGreaterThan(replacement.feeBump!.originalFee)
    expect(replacement.feeBump!.replacementFeeRate).toBeGreaterThan(
      replacement.feeBump!.originalFeeRate
    )
    expect(replacement.feeBump!.feeDelta).toBeGreaterThanOrEqual(
      replacement.feeBump!.replacementVsize
    )
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) })
    )
    // Both assessments read the raw original and checked its one input's
    // signature against the account key.
    expect(getTxHexMock).toHaveBeenCalledWith(live.txid)
    expect(verifyPqcMock).toHaveBeenCalledTimes(2)
    for (const [pubkey] of verifyPqcMock.mock.calls) {
      expect(bytesToHex(pubkey)).toBe(account.pubkey)
    }
    // The recipient being paid again sits beside the transaction it replaces;
    // the memo pays nothing and the change returns to the account.
    expect(replacement.action?.details?.slice(0, 4)).toEqual([
      { label: 'replaces_transaction', value: live.txid, type: PsbtActionDetailType.TEXT },
      { label: 'to', value: recipientAddress(), type: PsbtActionDetailType.ADDRESS },
      { label: 'amount', value: 10_000, type: PsbtActionDetailType.SATOSHIS },
      {
        label: 'original_fee',
        value: original.estimatedFee,
        type: PsbtActionDetailType.SATOSHIS,
      },
    ])

    const keys = replacement.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(replacement.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: keys.map(key => ({
        inputIndex: key.inputIndex,
        pubkey: bytesToHex(key.pubkey),
        leafHash: bytesToHex(key.leafHash),
        hashType: 0,
        cacheKey: '44'.repeat(32),
        cached: false,
        counter: null,
      })),
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    const signedReplacement = await wallet.signPsbtV2(replacement)
    expect(replacement.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(replacement.psbtHex),
    })
    expect(signedReplacement.qbitBroadcastIdentity).toEqual(replacement.qbitBroadcastIdentity)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({ keys }),
      SIGNATURE_BUDGET,
      false
    )
    expect(extractP2mrTransaction(parsePsbt(hexToBytes(signedReplacement.psbtHex!))).length).toBe(
      replacement.feeBump!.replacementVsize
    )
  })

  it('drops replacement change below the qbit dust floor and accounts for the exact final size', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const inputSats = 50_000
    const provisional = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '32'.repeat(32),
          vout: 0,
          satoshis: inputSats,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const amountWithFiveThousandChange = inputSats - provisional.estimatedFee! - 5_000
    const original = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: amountWithFiveThousandChange,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '32'.repeat(32),
          vout: 0,
          satoshis: inputSats,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const live = liveTransactionFromPsbt(original.psbtHex)
    getTxMock.mockResolvedValue(live)

    const replacement = await wallet.createBumpFeeQbitPsbt({ txid: live.txid })
    const summary = decodePsbt(parsePsbt(hexToBytes(replacement.psbtHex)))

    expect(summary.outputs).toHaveLength(1)
    expect(replacement.feeBump).toMatchObject({
      changeBefore: 5_000,
      changeAfter: 0,
      changeDropped: true,
      feeDelta: 5_000,
    })
    expect(Number(summary.fee)).toBe(replacement.feeBump!.replacementFee)
    expect(replacement.feeBump!.replacementFeeRate).toBe(
      replacement.feeBump!.replacementFee / replacement.feeBump!.replacementVsize
    )
  })

  it('rejects a change-dropping replacement above its exact-size fee ceiling', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const leafScript = hexToBytes(account.p2mr.leafScript)
    const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
    const p2mrOutputScriptLength = hexToBytes(account.p2mr.scriptPubKey).length
    const originalEstimate = estimateQbitP2mrTransaction({
      inputCount: 1,
      outputScriptLengths: [p2mrOutputScriptLength, p2mrOutputScriptLength],
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
      feeRate: QBIT_MAX_FEE_RATE - 1,
    })
    const replacementEstimate = estimateQbitP2mrTransaction({
      inputCount: 1,
      outputScriptLengths: [p2mrOutputScriptLength],
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
    })
    const amount = 10_000
    const changeBefore = 5_000
    const original = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount,
      feeRate: QBIT_MAX_FEE_RATE - 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '35'.repeat(32),
          vout: 0,
          satoshis: amount + originalEstimate.fee + changeBefore,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const live = liveTransactionFromPsbt(original.psbtHex)
    getTxMock.mockResolvedValue(live)

    expect(live.fee / live.size).toBe(QBIT_MAX_FEE_RATE - 1)
    expect(live.vout.at(-1)!.value).toBe(changeBefore)
    expect(live.fee + changeBefore).toBeGreaterThan(qbitMaximumTotalFee(replacementEstimate.vsize))
    await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
      eligible: false,
      reason: 'insufficient_change',
    })
  })

  it('rejects replacement when the full change output cannot pay the incremental relay floor', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const inputSats = 50_000
    const utxo = {
      txid: '34'.repeat(32),
      vout: 0,
      satoshis: inputSats,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }
    const provisional = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [utxo],
    })
    const original = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: inputSats - provisional.estimatedFee! - QBIT_P2MR_DUST,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [utxo],
    })
    const live = liveTransactionFromPsbt(original.psbtHex)
    getTxMock.mockResolvedValue(live)

    await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
      eligible: false,
      reason: 'insufficient_change',
    })
  })

  it('binds a fee replacement to the network its original was fetched on, not the one active when assessment returns', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const original = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '32'.repeat(32),
          vout: 0,
          satoshis: 100_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const live = liveTransactionFromPsbt(original.psbtHex)
    // Another window switches networks while the original is being fetched
    // and stays there through the fee quote and the signing preflight.
    getTxMock.mockImplementation(async () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
      return live
    })
    esploraClientMock.mockClear()
    mempoolQbitClientMock.mockClear()

    const replacement = await wallet.createBumpFeeQbitPsbt({ txid: live.txid })

    // The replacement is fetched, priced and bound on the network the request
    // started on, where its inputs exist; nothing reached the other network.
    expect(replacement.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(replacement.psbtHex),
    })
    const mainnetEndpoint = CHAINS_MAP[ChainType.QBIT_MAINNET]!.endpoints[0]
    for (const client of [esploraClientMock, mempoolQbitClientMock]) {
      expect(client.mock.calls.map(([options]) => (options as any).baseUrl)).not.toContain(
        mainnetEndpoint
      )
    }
    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)

    // Switching back before approving no longer rejects an otherwise valid
    // replacement: signing accepts it on the network it was built for.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    const keys = replacement.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(replacement.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(6),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    await expect(wallet.signPsbtV2(replacement)).resolves.toMatchObject({
      qbitBroadcastIdentity: replacement.qbitBroadcastIdentity,
    })
  })

  it('binds a send and a send-all to the network active when the request started, not the one active after the fee quote', async () => {
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxos = () => [
      {
        txid: '33'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
    ]
    // Another window switches networks while the fee quote is in flight.
    getFeeTiersMock.mockImplementation(async () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
      return [
        { target: 20, feeRate: 1 },
        { target: 6, feeRate: 3 },
        { target: 2, feeRate: 9 },
      ]
    })

    const send = await new WalletController().createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: utxos(),
    })
    expect(send.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(send.psbtHex),
    })

    // A fresh controller so the quote is fetched again rather than cached.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    const sendAll = await new WalletController().createSendAllQbitPsbt({
      to: recipientAddress(),
      // The public signature requires a rate; the builder resolves a missing
      // one from the quote, which is the await under test here.
      feeRate: undefined as unknown as number,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: utxos(),
    })
    expect(sendAll.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(sendAll.psbtHex),
    })
    expect(getFeeTiersMock).toHaveBeenCalledTimes(2)
  })

  it('refuses inputs loaded on another network, or on no named network, before any signature is spent', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxos = [
      {
        txid: '34'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
    ]

    // The UI read its cached outputs while the wallet was on testnet4 and
    // another window switched to regtest before this request started. The
    // scriptPubKey is the same on both networks, so only the chain the
    // outputs were loaded on can tell them apart.
    for (const build of [
      () =>
        wallet.createSendQbitPsbt({
          to: recipientAddress(),
          amount: 10_000,
          feeRate: 1,
          qbitUtxoChain: ChainType.QBIT_TESTNET4,
          qbitUtxos: utxos,
        }),
      () =>
        wallet.createSendAllQbitPsbt({
          to: recipientAddress(),
          feeRate: 1,
          qbitUtxoChain: ChainType.QBIT_TESTNET4,
          qbitUtxos: utxos,
        }),
    ]) {
      await expect(build()).rejects.toThrow('Qbit network changed since the inputs were loaded')
    }
    // Outputs that name no network are refused too: the builder never
    // assumes they belong to the active one.
    await expect(
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 1,
        qbitUtxos: utxos,
      })
    ).rejects.toThrow('Qbit inputs must name the network they were loaded on')
    await expect(
      wallet.createSendAllQbitPsbt({ to: recipientAddress(), feeRate: 1, qbitUtxos: utxos })
    ).rejects.toThrow('Qbit inputs must name the network they were loaded on')
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    expect(getAddressUtxosMock).not.toHaveBeenCalled()

    // Outputs the builder loads itself come from the request's own network.
    getAddressUtxosMock.mockResolvedValueOnce([
      { txid: '35'.repeat(32), vout: 0, value: 100_000, status: { confirmed: true, block_height: 10 } },
    ])
    getTxMock.mockResolvedValueOnce({
      txid: '35'.repeat(32),
      vin: [{ is_coinbase: false }],
      vout: [{ value: 100_000, scriptpubkey: account.p2mr.scriptPubKey }],
    })
    const fetched = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
    })
    expect(fetched.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(fetched.psbtHex),
    })
  })

  it('hands the UI its spendable outputs together with the network they were loaded on', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const reservedTxid = 'ac'.repeat(32)
    const availableTxid = 'ad'.repeat(32)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set([`${reservedTxid}:0`])
    )
    getAddressUtxosMock.mockResolvedValue(
      [reservedTxid, availableTxid].map(txid => ({
        txid,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      }))
    )
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
    }))

    const snapshot = await wallet.getQbitUtxoSnapshot()
    expect(snapshot.address).toBe(account.address)
    expect(snapshot.chain).toBe(ChainType.QBIT_REGTEST)
    expect(snapshot.utxos.map(utxo => utxo.txid)).toEqual([availableTxid])
    await expect(wallet.getQbitUtxos()).resolves.toEqual(snapshot.utxos)

    // The snapshot's own chain is what makes the outputs acceptable again.
    const send = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: snapshot.chain,
      qbitUtxos: snapshot.utxos,
    })
    expect(send.qbitBroadcastIdentity?.chain).toBe(ChainType.QBIT_REGTEST)
  })

  it('joins a snapshot read already running for the account instead of walking again (#342)', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const other = p2mrAccount('22'.repeat(32))
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const listing = (...txids: string[]) =>
      txids.map(txid => ({
        txid,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      }))
    const reads: {
      address: string
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }[] = []
    getAddressUtxosMock.mockImplementation(
      (address: string) =>
        new Promise((resolve, reject) => {
          reads.push({ address, resolve, reject })
        })
    )
    const otherTxid = 'af'.repeat(32)
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [
        {
          value: 50_000,
          scriptpubkey: txid === otherTxid ? other.p2mr.scriptPubKey : account.p2mr.scriptPubKey,
        },
      ],
    }))
    const txids = (snapshot: { utxos: { txid: string }[] }) => snapshot.utxos.map(utxo => utxo.txid)

    // The Send screen opened, left and opened again while the read runs.
    const first = wallet.getQbitUtxoSnapshot()
    const second = wallet.getQbitUtxoSnapshot()
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    // Another account's read does not join it, and neither does a read
    // that must be fresh.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(other as any)
    const otherRead = wallet.getQbitUtxoSnapshot()
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const freshRead = wallet.getQbitUtxos()
    await vi.waitFor(() => expect(reads).toHaveLength(3))
    // A send took an output while the read ran, and the explorer shows it
    // pending. A read asked for after it starts afresh, so it can see the
    // send's change.
    const spent = 'ae'.repeat(32)
    const kept = 'ad'.repeat(32)
    const change = 'ce'.repeat(32)
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set([`${spent}:0`])
    )
    getAddressStatsMock.mockImplementation(async address => quietAddressStats(address, 1))
    const afterSend = wallet.getQbitUtxoSnapshot()
    await vi.waitFor(() => expect(reads).toHaveLength(4))
    expect(reads.map(read => read.address)).toEqual([
      account.address,
      other.address,
      account.address,
      account.address,
    ])

    // The joined read's answer leaves out the output the send took.
    reads[0]!.resolve(listing(spent, kept))
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second])
    expect(firstSnapshot).toMatchObject({ address: account.address, chain: ChainType.QBIT_REGTEST })
    expect(txids(firstSnapshot)).toEqual([kept])
    expect(secondSnapshot).toEqual(firstSnapshot)
    reads[1]!.resolve(listing(otherTxid))
    const otherSnapshot = await otherRead
    expect(otherSnapshot.address).toBe(other.address)
    expect(txids(otherSnapshot)).toEqual([otherTxid])
    reads[2]!.resolve(listing(spent, kept))
    await expect(freshRead).resolves.toHaveLength(1)
    reads[3]!.resolve(listing(spent, kept, change))
    expect(txids(await afterSend)).toEqual([kept, change])

    // Once a read settles the next one reads afresh, and a failure reaches
    // every caller that joined it without being kept.
    const failing = [wallet.getQbitUtxoSnapshot(), wallet.getQbitUtxoSnapshot()]
    await vi.waitFor(() => expect(reads).toHaveLength(5))
    reads[4]!.reject(new Error('explorer unavailable'))
    for (const read of failing) {
      await expect(read).rejects.toThrow('explorer unavailable')
    }
    const retry = wallet.getQbitUtxoSnapshot()
    await vi.waitFor(() => expect(reads).toHaveLength(6))
    reads[5]!.resolve(listing(kept))
    expect(txids(await retry)).toEqual([kept])

    // Without the statistics there is nothing to tell the reads apart by,
    // so none is shared.
    getAddressStatsMock.mockRejectedValue(new Error('stats unavailable'))
    const unshared = [wallet.getQbitUtxoSnapshot(), wallet.getQbitUtxoSnapshot()]
    await vi.waitFor(() => expect(reads).toHaveLength(8))
    reads[6]!.resolve(listing(kept))
    reads[7]!.resolve(listing(kept))
    await expect(Promise.all(unshared)).resolves.toHaveLength(2)
  })

  it('fails fee-bump eligibility closed across confirmed, gone, final, foreign and no-change transactions', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxo = {
      txid: '33'.repeat(32),
      vout: 0,
      satoshis: 50_000,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }
    const replaceable = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [utxo],
    })
    const final = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      enableRBF: false,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [utxo],
    })
    const sendAll = await wallet.createSendAllQbitPsbt({
      to: recipientAddress(),
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [utxo],
    })

    const confirmed = liveTransactionFromPsbt(replaceable.psbtHex, { confirmed: true })
    getTxMock.mockResolvedValueOnce(confirmed)
    await expect(wallet.getQbitFeeBumpEligibility(confirmed.txid)).resolves.toEqual({
      eligible: false,
      reason: 'confirmed',
    })

    getTxMock.mockRejectedValueOnce(
      new QbitApiError('not_found', 'transaction not found', { status: 404 })
    )
    await expect(wallet.getQbitFeeBumpEligibility('ae'.repeat(32))).resolves.toEqual({
      eligible: false,
      reason: 'gone',
    })

    const finalLive = liveTransactionFromPsbt(final.psbtHex)
    getTxMock.mockResolvedValueOnce(finalLive)
    await expect(wallet.getQbitFeeBumpEligibility(finalLive.txid)).resolves.toEqual({
      eligible: false,
      reason: 'non_replaceable',
    })

    const foreign = liveTransactionFromPsbt(replaceable.psbtHex)
    foreign.vin[0]!.prevout!.scriptpubkey = '51'.repeat(34)
    getTxMock.mockResolvedValueOnce(foreign)
    await expect(wallet.getQbitFeeBumpEligibility(foreign.txid)).resolves.toEqual({
      eligible: false,
      reason: 'not_wallet_transaction',
    })

    const sendAllLive = liveTransactionFromPsbt(sendAll.psbtHex)
    getTxMock.mockResolvedValueOnce(sendAllLive)
    await expect(wallet.getQbitFeeBumpEligibility(sendAllLive.txid)).resolves.toEqual({
      eligible: false,
      reason: 'no_change',
    })

    // Pending in the explorer's JSON, but its raw bytes are already gone.
    const vanishing = liveTransactionFromPsbt(replaceable.psbtHex)
    rawTransactions.delete(vanishing.txid)
    getTxMock.mockResolvedValueOnce(vanishing)
    await expect(wallet.getQbitFeeBumpEligibility(vanishing.txid)).resolves.toEqual({
      eligible: false,
      reason: 'gone',
    })

    getTxMock.mockRejectedValueOnce(new QbitApiError('network', 'offline'))
    await expect(wallet.getQbitFeeBumpEligibility('b2'.repeat(32))).resolves.toEqual({
      eligible: false,
      reason: 'unverifiable',
    })
  })

  describe('fee bump of an original a later transaction spends (#274)', () => {
    async function pendingOriginal(
      wallet: WalletController,
      account: ReturnType<typeof p2mrAccount>
    ) {
      const original = await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [
          {
            txid: '35'.repeat(32),
            vout: 0,
            satoshis: 100_000,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
      const live = liveTransactionFromPsbt(original.psbtHex)
      getTxMock.mockResolvedValue(live)
      vi.mocked(keyringService.preflightP2mrPsbtSigning).mockClear()
      getFeeTiersMock.mockClear()
      return live
    }

    function spentAt(live: { vout: unknown[] }, spentIndex: number, spender = 'b7'.repeat(32)) {
      return live.vout.map((_, index) =>
        index === spentIndex
          ? { spent: true, txid: spender, vin: 0, status: { confirmed: false } }
          : { spent: false }
      )
    }

    it.each([
      ['its change, which funded a later payment', 1],
      ['the recipient output, which the recipient spent', 0],
    ])('refuses before pricing when the explorer shows a spender of %s', async (_name, index) => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const live = await pendingOriginal(wallet, account)
      getTxOutspendsMock.mockResolvedValue(spentAt(live, index))

      await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
        eligible: false,
        reason: 'has_descendants',
      })
      await expect(wallet.createBumpFeeQbitPsbt({ txid: live.txid })).rejects.toThrow(
        'fee_bump_unavailable (has_descendants)'
      )
      expect(getTxOutspendsMock).toHaveBeenCalledWith(live.txid)
      expect(getFeeTiersMock).not.toHaveBeenCalled()
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    })

    it('refuses on the wallet’s own record of a later spend the explorer has not indexed', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const live = await pendingOriginal(wallet, account)
      vi.mocked(qbitSendGuardService.hasDependentSpend).mockResolvedValue(true)

      await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
        eligible: false,
        reason: 'has_descendants',
      })
      expect(qbitSendGuardService.takeRecentSpendersToProbe).toHaveBeenCalledWith(
        ChainType.QBIT_REGTEST,
        account.address
      )
      expect(qbitSendGuardService.hasDependentSpend).toHaveBeenCalledWith(
        ChainType.QBIT_REGTEST,
        live.txid
      )
    })

    it('re-checks for later spends when it builds the replacement, not only when it offered one', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const live = await pendingOriginal(wallet, account)

      await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toMatchObject({
        eligible: true,
      })
      // A payment from the original's change goes out while "Speed up" is shown.
      getTxOutspendsMock.mockResolvedValue(spentAt(live, 1))

      await expect(wallet.createBumpFeeQbitPsbt({ txid: live.txid })).rejects.toThrow(
        'fee_bump_unavailable (has_descendants)'
      )
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    })

    it.each([
      [
        'a short answer',
        (live: { vout: unknown[] }) => live.vout.slice(1).map(() => ({ spent: false })),
      ],
      [
        'a malformed spender',
        (live: { vout: unknown[] }) => [{ spent: false }, { spent: true, txid: 'zz' }],
      ],
      ['a non-array answer', () => ({ spent: false })],
    ])('reports %s from the explorer as unverifiable', async (_name, answer) => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const live = await pendingOriginal(wallet, account)
      getTxOutspendsMock.mockResolvedValue(answer(live))

      await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
        eligible: false,
        reason: 'unverifiable',
      })
      await expect(wallet.createBumpFeeQbitPsbt({ txid: live.txid })).rejects.toThrow(
        'fee_bump_unavailable (unverifiable)'
      )
    })

    it('fails closed when the explorer cannot answer for the spenders', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const live = await pendingOriginal(wallet, account)
      getTxOutspendsMock.mockRejectedValue(new QbitApiError('network', 'offline'))

      await expect(wallet.getQbitFeeBumpEligibility(live.txid)).resolves.toEqual({
        eligible: false,
        reason: 'unverifiable',
      })
      await expect(wallet.createBumpFeeQbitPsbt({ txid: live.txid })).rejects.toThrow(
        'fee_bump_unavailable'
      )
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    })
  })

  describe('unconfirmed outputs a send selects (#279)', () => {
    it('builds from confirmed outputs and own change, never from an unconfirmed payment by someone else', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const foreignScript = bytesToHex(p2mrScriptPubKey(new Uint8Array(32).fill(0x5a)))
      const confirmedTxid = '61'.repeat(32)
      const ownChangeTxid = '62'.repeat(32)
      const foreignTxid = '63'.repeat(32)
      const fundingTxid = '60'.repeat(32)
      const inputFrom = (scriptpubkey: string) => ({
        txid: fundingTxid,
        vout: 0,
        is_coinbase: false,
        prevout: { scriptpubkey, value: 90_000 },
      })
      const parents: Record<string, { vin: unknown[]; value: number }> = {
        [fundingTxid]: { vin: [inputFrom(foreignScript)], value: 90_000 },
        [confirmedTxid]: { vin: [inputFrom(foreignScript)], value: 4_000 },
        [ownChangeTxid]: { vin: [inputFrom(account.p2mr.scriptPubKey)], value: 30_000 },
        [foreignTxid]: { vin: [inputFrom(foreignScript)], value: 80_000 },
      }
      getAddressUtxosMock.mockResolvedValue(
        [foreignTxid, ownChangeTxid, confirmedTxid].map(txid => ({
          txid,
          vout: 0,
          value: parents[txid]!.value,
          status:
            txid === confirmedTxid ? { confirmed: true, block_height: 10 } : { confirmed: false },
        }))
      )
      getTxMock.mockImplementation(async (txid: string) => ({
        txid,
        vin: parents[txid]!.vin,
        vout: [{ scriptpubkey: account.p2mr.scriptPubKey, value: parents[txid]!.value }],
        size: 3_860,
        weight: 3_860,
        status: { confirmed: txid === fundingTxid || txid === confirmedTxid },
      }))

      await expect(wallet.getQbitUtxos()).resolves.toEqual([
        expect.objectContaining({ txid: confirmedTxid, satoshis: 4_000 }),
        expect.objectContaining({ txid: ownChangeTxid, satoshis: 30_000 }),
      ])

      // 20,000 needs the own change on top of the confirmed output; the
      // larger unconfirmed payment from someone else is never selected.
      const send = await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 20_000,
        feeRate: 1,
      })
      const inputs = decodePsbt(parsePsbt(hexToBytes(send.psbtHex))).inputs.map(input =>
        reverseTxid(bytesToHex(input.prevout.txid))
      )
      expect(inputs).toEqual([confirmedTxid, ownChangeTxid])

      await expect(
        wallet.createSendQbitPsbt({ to: recipientAddress(), amount: 40_000, feeRate: 1 })
      ).rejects.toThrow('Insufficient balance.')
    })
  })

  describe('unconfirmed ancestor size limit (#345)', () => {
    // Send #1 spent 105 inputs and left 1,000,000 of change: 395,108 vB, unconfirmed.
    function largeParentAccount() {
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const script = account.p2mr.scriptPubKey
      const fundingTxid = '70'.repeat(32)
      const parentTxid = '71'.repeat(32)
      const confirmedTxids = Array.from({ length: 45 }, (_, index) =>
        (0x80 + index).toString(16).repeat(32)
      )
      const txs = new Map<string, unknown>([
        [
          parentTxid,
          {
            txid: parentTxid,
            vin: [
              {
                txid: fundingTxid,
                vout: 0,
                is_coinbase: false,
                prevout: { scriptpubkey: script, value: 1_500_000 },
              },
            ],
            vout: [
              { scriptpubkey: recipientAddressScript(), value: 100_000 },
              { scriptpubkey: script, value: 1_000_000 },
            ],
            size: 395_108,
            weight: 395_108,
            status: { confirmed: false },
          },
        ],
        [fundingTxid, { txid: fundingTxid, vin: [], vout: [], status: { confirmed: true } }],
        ...confirmedTxids.map(
          txid =>
            [
              txid,
              {
                txid,
                vin: [{ is_coinbase: false }],
                vout: [{ scriptpubkey: script, value: 100_000 }],
                status: { confirmed: true, block_height: 10 },
              },
            ] as const
        ),
      ])
      getAddressUtxosMock.mockResolvedValue([
        ...confirmedTxids.map(txid => ({
          txid,
          vout: 0,
          value: 100_000,
          status: { confirmed: true, block_height: 10 },
        })),
        { txid: parentTxid, vout: 1, value: 1_000_000, status: { confirmed: false } },
      ])
      getTxMock.mockImplementation(async (txid: string) => txs.get(txid))
      return { parentTxid }
    }

    it('refuses before signing a send of 45 confirmed outputs and the change of a 105-input parent', async () => {
      const { parentTxid } = largeParentAccount()
      const wallet = new WalletController()

      await expect(wallet.getQbitUtxos()).resolves.toContainEqual(
        expect.objectContaining({
          txid: parentTxid,
          unconfirmed: true,
          unconfirmedAncestors: [{ txid: parentTxid, vsize: 395_108 }],
        })
      )
      // 46 inputs (173,150 vB) behind the parent make a 568 kB package.
      await expect(
        wallet.createSendQbitPsbt({ to: recipientAddress(), amount: 4_500_000, feeRate: 1 })
      ).rejects.toThrow('send_exceeds_ancestor_size')
      await expect(
        wallet.createSendAllQbitPsbt({ to: recipientAddress(), feeRate: 1 })
      ).rejects.toThrow('send_exceeds_ancestor_size')
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()

      // UI-loaded outputs are held to the same limit.
      const snapshot = await wallet.getQbitUtxoSnapshot()
      await expect(
        wallet.createSendQbitPsbt({
          to: recipientAddress(),
          amount: 4_500_000,
          feeRate: 1,
          qbitUtxos: snapshot.utxos,
          qbitUtxoChain: snapshot.chain,
        })
      ).rejects.toThrow('send_exceeds_ancestor_size')
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    })

    it('still builds a smaller send from the confirmed outputs, or from the change and one more', async () => {
      const { parentTxid } = largeParentAccount()
      const wallet = new WalletController()
      const inputTxids = (psbtHex: string) =>
        decodePsbt(parsePsbt(hexToBytes(psbtHex))).inputs.map(input =>
          reverseTxid(bytesToHex(input.prevout.txid))
        )

      const confirmedOnly = await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 1_050_000,
        feeRate: 1,
      })
      expect(inputTxids(confirmedOnly.psbtHex)).not.toContain(parentTxid)

      const snapshot = await wallet.getQbitUtxoSnapshot()
      const change = snapshot.utxos.find(utxo => utxo.txid === parentTxid)!
      const withChange = await wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 1_050_000,
        feeRate: 1,
        qbitUtxos: [snapshot.utxos[0]!, change],
        qbitUtxoChain: snapshot.chain,
      })
      expect(inputTxids(withChange.psbtHex)).toEqual([snapshot.utxos[0]!.txid, parentTxid])
      expect(395_108 + withChange.estimatedVsize!).toBeLessThanOrEqual(404_000)
    })
  })

  describe('fee-bump original provenance', () => {
    const attackerScript = () => p2mrScriptPubKey(new Uint8Array(32).fill(0xee))

    /** An unsigned RBF PSBT spending `inputs` (each owned by its account) to `outputs`. */
    function originalPsbtHex(
      inputs: { owner: ReturnType<typeof p2mrAccount>; txid: string; value: bigint }[],
      outputs: { value: bigint; scriptPubKey: Uint8Array }[],
      { restrictedOutputMode }: { restrictedOutputMode?: false } = {}
    ) {
      return bytesToHex(
        serializePsbt(
          createP2mrPsbt({
            inputs: inputs.map(({ owner, txid, value }) => {
              const leafScript = hexToBytes(owner.p2mr.leafScript)
              return {
                prevout: { txid: hexToBytes(txid), vout: 0 },
                witnessUtxo: { value, scriptPubKey: hexToBytes(owner.p2mr.scriptPubKey) },
                leafScript,
                controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
                merkleRoot: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript),
              }
            }),
            outputs,
            ...(restrictedOutputMode === undefined ? {} : { restrictedOutputMode }),
          })
        )
      )
    }

    async function honestOriginal(
      wallet: WalletController,
      account: ReturnType<typeof p2mrAccount>
    ) {
      return wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [
          {
            txid: '61'.repeat(32),
            vout: 0,
            satoshis: 100_000,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
    }

    async function expectUnverifiable(wallet: WalletController, txid: string) {
      vi.mocked(keyringService.preflightP2mrPsbtSigning).mockClear()
      await expect(wallet.getQbitFeeBumpEligibility(txid)).resolves.toEqual({
        eligible: false,
        reason: 'unverifiable',
      })
      await expect(wallet.createBumpFeeQbitPsbt({ txid })).rejects.toThrow(
        'fee_bump_unavailable (unverifiable)'
      )
      expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    }

    it('refuses raw bytes that do not hash to the requested txid', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      const forged = transactionCore.Transaction.fromHex(signedRawTransaction(original.psbtHex))
      forged.outs[0]!.script = Buffer.from(attackerScript())

      // The JSON is the honest original's; the bytes served for it pay the attacker.
      const live = liveTransactionFromPsbt(original.psbtHex, { rawHex: forged.toHex() })
      getTxMock.mockResolvedValue(live)

      await expectUnverifiable(wallet, live.txid)
      expect(verifyPqcMock).not.toHaveBeenCalled()
    })

    it('treats raw bytes the API client refuses as unverifiable', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      const live = liveTransactionFromPsbt(original.psbtHex)
      getTxMock.mockResolvedValue(live)
      // @qbit-oss/api checks the reply hashes to the requested txid itself.
      getTxHexMock.mockRejectedValue(
        new QbitApiError('parse', `transaction hex does not hash to txid ${live.txid}`)
      )

      await expectUnverifiable(wallet, live.txid)
      expect(verifyPqcMock).not.toHaveBeenCalled()
    })

    it('refuses an original whose raw recipient differs from the JSON and carries the honest signatures', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      // The attacker swaps the recipient, keeps the account's real witnesses
      // and serves JSON that shows the honest recipient under the new txid.
      const forged = transactionCore.Transaction.fromHex(signedRawTransaction(original.psbtHex))
      forged.outs[0]!.script = Buffer.from(attackerScript())
      const forgedTxid = forged.getId()
      rawTransactions.set(forgedTxid, forged.toHex())
      getTxMock.mockResolvedValue({
        ...liveTransactionFromPsbt(original.psbtHex),
        txid: forgedTxid,
      })

      await expectUnverifiable(wallet, forgedTxid)
      expect(verifyPqcMock).toHaveBeenCalled()
    })

    it('refuses an original whose prevout amounts the explorer misreports', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      // A consistent lie: one more input sat and one more fee sat. Only the
      // signature, which commits to the real amount, can tell.
      const live = liveTransactionFromPsbt(original.psbtHex)
      live.vin[0]!.prevout!.value += 1
      live.fee += 1
      getTxMock.mockResolvedValue(live)

      await expectUnverifiable(wallet, live.txid)
    })

    it('refuses an original whose inputs are unsigned or carry signatures that do not verify', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      const unsignedTransaction = parsePsbt(hexToBytes(original.psbtHex)).global.find(
        entry => entry.key.length === 1 && entry.key[0] === 0
      )!.value

      for (const rawHex of [
        bytesToHex(unsignedTransaction),
        signedRawTransaction(original.psbtHex, {
          sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
        }),
        signedRawTransaction(original.psbtHex, { hashType: SIGHASH_NONE }),
      ]) {
        const live = liveTransactionFromPsbt(original.psbtHex, { rawHex })
        getTxMock.mockResolvedValue(live)
        await expectUnverifiable(wallet, live.txid)
      }
    })

    it('refuses an original with an input another key signed, even when the explorer attributes it to the account', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      const other = p2mrAccount('33'.repeat(32))
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const psbtHex = originalPsbtHex(
        [
          { owner: account, txid: '62'.repeat(32), value: 50_000n },
          { owner: other, txid: '63'.repeat(32), value: 50_000n },
        ],
        [
          { value: 10_000n, scriptPubKey: hexToBytes(recipientAddressScript()) },
          { value: 80_000n, scriptPubKey: hexToBytes(account.p2mr.scriptPubKey) },
        ]
      )

      const honest = liveTransactionFromPsbt(psbtHex)
      getTxMock.mockResolvedValue(honest)
      await expect(wallet.getQbitFeeBumpEligibility(honest.txid)).resolves.toEqual({
        eligible: false,
        reason: 'not_wallet_transaction',
      })

      const lying = liveTransactionFromPsbt(psbtHex)
      lying.vin[1]!.prevout!.scriptpubkey = account.p2mr.scriptPubKey
      getTxMock.mockResolvedValue(lying)
      await expectUnverifiable(wallet, lying.txid)
    })

    it('refuses an account whose stored scripts are not the single-key leaf of its public key', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const original = await honestOriginal(wallet, account)
      const live = liveTransactionFromPsbt(original.psbtHex)
      getTxMock.mockResolvedValue(live)
      const other = p2mrAccount('33'.repeat(32))

      for (const p2mr of [
        { ...account.p2mr, leafScript: other.p2mr.leafScript },
        { ...account.p2mr, scriptPubKey: other.p2mr.scriptPubKey },
      ]) {
        vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ ...account, p2mr } as any)
        await expectUnverifiable(wallet, live.txid)
      }
      expect(getTxMock).not.toHaveBeenCalled()
    })

    it('refuses to carry a non-P2MR or value-bearing OP_RETURN output over from an original the account signed', async () => {
      const wallet = new WalletController()
      const account = p2mrAccount()
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
      const change = { value: 30_000n, scriptPubKey: hexToBytes(account.p2mr.scriptPubKey) }

      for (const recipient of [
        { value: 10_000n, scriptPubKey: hexToBytes('0014' + '44'.repeat(20)) },
        { value: 10_000n, scriptPubKey: hexToBytes('5120' + '44'.repeat(32)) },
        { value: 1n, scriptPubKey: hexToBytes('6a0474657374') },
      ]) {
        // @qbit-oss/protocol refuses to build or sign a transaction qbit
        // Core's restricted-output rule rejects; such an original can only
        // come from a regtest node run with -p2mronly=0.
        const psbtHex = originalPsbtHex(
          [{ owner: account, txid: '64'.repeat(32), value: 50_000n }],
          [recipient, change],
          { restrictedOutputMode: false }
        )
        const live = liveTransactionFromPsbt(psbtHex, {
          rawHex: signedRawTransaction(psbtHex, { restrictedOutputMode: false }),
        })
        getTxMock.mockResolvedValue(live)
        await expectUnverifiable(wallet, live.txid)
      }
    })
  })

  it('uses mempool-qbit fee targets for qbit mempool endpoints', async () => {
    CHAINS_MAP[ChainType.QBIT_REGTEST]!.qbitApiSurface = 'mempool-qbit'
    getFeeTiersMock.mockResolvedValueOnce([
      { target: 3, feeRate: 1 },
      { target: 2, feeRate: 3 },
      { target: 1, feeRate: 9 },
    ])

    const wallet = new WalletController()

    await expect(wallet.getFeeSummary()).resolves.toEqual({
      list: [
        { title: 'Slow', desc: '~3 min (3 blocks)', feeRate: 1, targetBlocks: 3 },
        { title: 'Normal', desc: '~2 min (2 blocks)', feeRate: 3, targetBlocks: 2 },
        { title: 'Fast', desc: '~1 min (1 block)', feeRate: 9, targetBlocks: 1 },
      ],
      quote: {
        source: 'mempool-qbit',
        availability: 'available',
        freshness: 'live',
        fetchedAt: expect.any(Number),
      },
    })
    expect(mempoolQbitClientMock).toHaveBeenCalledWith({
      // Raised so a rescan fits within the client's page ceiling.
      maxAddressHistoryPages: 512,
      baseUrl: 'http://127.0.0.1:3002',
      ...EXPLORER_BUDGETS,
    })
  })

  it('reuses only fresh exact-chain quotes and fails closed after expiry', async () => {
    let now = 1_000
    const wallet = new WalletController({ now: () => now })

    const live = await wallet.getFeeSummary()
    expect(live.quote).toEqual({
      source: 'esplora',
      availability: 'available',
      freshness: 'live',
      fetchedAt: 1_000,
    })

    now += 59_999
    const cached = await wallet.getFeeSummary()
    expect(cached.quote).toMatchObject({ freshness: 'cached', fetchedAt: 1_000 })
    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)

    now += 1
    getFeeTiersMock.mockResolvedValueOnce([
      { target: 20, feeRate: 2 },
      { target: 6, feeRate: 4 },
      { target: 2, feeRate: 8 },
    ])
    const refreshed = await wallet.getFeeSummary()
    expect(refreshed.quote).toMatchObject({ freshness: 'live', fetchedAt: 61_000 })
    expect(refreshed.list.map(tier => tier.feeRate)).toEqual([2, 4, 8])

    now += 60_000
    getFeeTiersMock.mockRejectedValueOnce(new Error('offline'))
    const staleFallback = await wallet.getFeeSummary()
    expect(staleFallback).toMatchObject({
      list: [{ feeRate: 1 }, { feeRate: 1 }, { feeRate: 1 }],
      quote: {
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'stale',
      },
    })

    const uncachedWallet = new WalletController({ now: () => now })
    getFeeTiersMock.mockRejectedValueOnce(new Error('offline'))
    await expect(uncachedWallet.getFeeSummary()).resolves.toMatchObject({
      quote: {
        availability: 'unavailable',
        fallbackReason: 'unavailable',
      },
    })
  })

  it('timestamps a slow fee refresh when the provider response completes', async () => {
    let releaseProviderResponse!: () => void
    const providerResponseGate = new Promise<void>(resolve => {
      releaseProviderResponse = resolve
    })
    getFeeTiersMock.mockImplementationOnce(async () => {
      await providerResponseGate
      return [
        { target: 20, feeRate: 2 },
        { target: 6, feeRate: 4 },
        { target: 2, feeRate: 8 },
      ]
    })

    let now = 1_000
    const wallet = new WalletController({ now: () => now })
    const liveRequest = wallet.getFeeSummary()
    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)

    now += 60_000
    releaseProviderResponse()
    const live = await liveRequest
    expect(live.quote).toMatchObject({ freshness: 'live', fetchedAt: 61_000 })

    const cached = await wallet.getFeeSummary()
    expect(cached.quote).toMatchObject({ freshness: 'cached', fetchedAt: 61_000 })
    expect(cached.list.map(tier => tier.feeRate)).toEqual([2, 4, 8])
    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent exact-key fee refreshes and preserves the fresh quote', async () => {
    let resolveSuccessfulRefresh!: () => void
    let releaseFailingRefresh!: () => void
    const successfulRefreshGate = new Promise<void>(resolve => {
      resolveSuccessfulRefresh = resolve
    })
    const failingRefreshGate = new Promise<void>(resolve => {
      releaseFailingRefresh = resolve
    })
    let providerCallCount = 0
    getFeeTiersMock.mockImplementation(async () => {
      providerCallCount += 1
      if (providerCallCount === 1) {
        await successfulRefreshGate
        return [
          { target: 20, feeRate: 2 },
          { target: 6, feeRate: 4 },
          { target: 2, feeRate: 8 },
        ]
      }
      await failingRefreshGate
      throw new Error('later concurrent failure')
    })

    const wallet = new WalletController({ now: () => 5_000 })
    const firstRequest = wallet.getFeeSummary()
    const secondRequest = wallet.getFeeSummary()

    resolveSuccessfulRefresh()
    releaseFailingRefresh()
    const [first, second] = await Promise.all([firstRequest, secondRequest])

    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.list).not.toBe(second.list)
    expect(first.list[0]).not.toBe(second.list[0])
    expect(first.quote).not.toBe(second.quote)
    expect(first.quote).toMatchObject({
      availability: 'available',
      freshness: 'live',
      fetchedAt: 5_000,
    })

    const cached = await wallet.getFeeSummary()
    expect(getFeeTiersMock).toHaveBeenCalledTimes(1)
    expect(cached.list.map(tier => tier.feeRate)).toEqual([2, 4, 8])
    expect(cached.quote).toMatchObject({
      availability: 'available',
      freshness: 'cached',
      fetchedAt: 5_000,
    })
  })

  it('isolates fresh fee caches by exact chain and endpoint', async () => {
    const now = 5_000
    const wallet = new WalletController({ now: () => now })
    const originalRegtestEndpoint = CHAINS_MAP[ChainType.QBIT_REGTEST]!.endpoints[0]!
    getFeeTiersMock.mockResolvedValue([
      { target: 1, feeRate: 9 },
      { target: 2, feeRate: 9 },
      { target: 3, feeRate: 3 },
      { target: 6, feeRate: 3 },
      { target: 20, feeRate: 1 },
    ])

    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await wallet.getFeeSummary()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    await wallet.getFeeSummary()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    expect((await wallet.getFeeSummary()).quote?.freshness).toBe('cached')

    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    await wallet.getFeeSummary()
    CHAINS_MAP[ChainType.QBIT_REGTEST]!.endpoints[0] = 'http://127.0.0.1:3999'
    try {
      await wallet.getFeeSummary()
    } finally {
      CHAINS_MAP[ChainType.QBIT_REGTEST]!.endpoints[0] = originalRegtestEndpoint
    }

    expect(getFeeTiersMock).toHaveBeenCalledTimes(4)
    expect(esploraClientMock).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:3999',
      ...EXPLORER_BUDGETS,
    })
  })

  it('constructs separate mainnet and Testnet4 mempool clients from exact chain endpoints', async () => {
    const wallet = new WalletController()

    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await wallet.getFeeSummary()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    await wallet.getFeeSummary()

    expect(mempoolQbitClientMock).toHaveBeenCalledTimes(2)
    expect(mempoolQbitClientMock).toHaveBeenNthCalledWith(1, {
      maxAddressHistoryPages: 512,
      baseUrl: 'https://mempool.qbit.org/api',
      ...EXPLORER_BUDGETS,
    })
    expect(mempoolQbitClientMock).toHaveBeenNthCalledWith(2, {
      maxAddressHistoryPages: 512,
      baseUrl: 'https://mempool-testnet.qbit.org/api',
      ...EXPLORER_BUDGETS,
    })
    expect(esploraClientMock).not.toHaveBeenCalled()
  })

  it('keeps generic signing requests disabled for Qbit HD accounts', () => {
    expect(getAccountCapabilities({ type: SharedKeyringType.QbitHdKeyring })).toMatchObject({
      canCreateSigningRequest: false,
      canSignP2mrMessage: true,
    })
  })

  it('prepares a provider PSBT for a local Qbit HD P2MR account through the counter-safe path', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const psbtHex = psbtHexWithDataOutputs(account, [])
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    const result = await wallet.prepareQbitProviderPsbt(psbtHex, {
      chain: ChainType.QBIT_REGTEST,
      autoFinalized: false,
    })

    expect(result).toMatchObject({
      psbtHex,
      toSignInputs: [{ index: 0, publicKey: account.pubkey }],
      qbitP2mrSigningKeys: [
        {
          inputIndex: 0,
          publicKey: account.pubkey,
          leafHash: bytesToHex(
            p2mrLeafHash(P2MR_LEAF_VERSION_V1, hexToBytes(account.p2mr.leafScript))
          ),
        },
      ],
      qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: unsignedTxid(psbtHex) },
      signatureBudget: SIGNATURE_BUDGET,
      autoFinalized: false,
    })
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({
        psbt: expect.any(Object),
        keys: expect.any(Array),
      })
    )
  })

  it('grants migration signing only while the reviewed PSBT spends a current protected UTXO', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const psbtHex = psbtHexWithDataOutputs(account, [])
    const protectedUtxo = {
      txid: '98'.repeat(32),
      vout: 0,
      satoshis: 50_000,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrating',
      migration: { network: 'regtest' },
    } as any)
    const getQbitUtxos = vi.spyOn(wallet, 'getQbitUtxos').mockResolvedValue([protectedUtxo])
    // Simulate a future qbit asset indexer through the chain-verified coverage
    // seam; the production classifier reports zero coverage until one exists.
    const assetCoverage = vi
      .spyOn(wallet as any, 'getQbitProtectedAssetCoverage')
      .mockResolvedValue({
        assetCount: 3,
        protectedOutpoints: new Set([`${protectedUtxo.txid}:0`]),
      })
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementation(
      async (_address, _input, options) => {
        if (options?.allowMigrationProtectedAssetTransfer) return SIGNATURE_BUDGET
        throw new Error('qbit_recovery_migration_signing_only')
      }
    )

    const protectedTransfer = await wallet.prepareQbitProviderPsbt(psbtHex, {
      chain: ChainType.QBIT_REGTEST,
    })

    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenNthCalledWith(
      1,
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) }),
      { allowMigrationProtectedAssetTransfer: true }
    )
    expect(protectedTransfer.action).toMatchObject({
      description: 'qbit_recovery_migration_signing_only',
      details: [
        {
          label: 'qbit_recovery_migrating_title',
          value: 3,
          type: 'TEXT',
          warning: true,
        },
      ],
    })
    expect(assetCoverage).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ txid: protectedUtxo.txid, vout: 0 }),
    ])

    assetCoverage.mockResolvedValue({ assetCount: 0, protectedOutpoints: new Set() })
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('qbit_recovery_migration_signing_only')
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenNthCalledWith(
      2,
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) })
    )

    assetCoverage.mockRejectedValueOnce(new Error('protected-asset lookup unavailable'))
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('protected-asset lookup unavailable')
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(2)

    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrated',
    } as any)
    assetCoverage.mockResolvedValue({
      assetCount: 1,
      protectedOutpoints: new Set([`${protectedUtxo.txid}:0`]),
    })
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('qbit_recovery_migration_signing_only')
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(3)
    expect(getQbitUtxos).toHaveBeenCalledTimes(3)
    expect(assetCoverage).toHaveBeenCalledTimes(3)
  })

  it('fails closed when the chain classifier cannot verify a reviewed outpoint', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const psbtHex = psbtHexWithDataOutputs(account, [])
    const inputTxid = '98'.repeat(32)
    const currentUtxo = {
      txid: inputTxid,
      vout: 0,
      satoshis: 50_000,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrating',
      migration: { network: 'regtest' },
    } as any)
    vi.spyOn(wallet, 'getQbitUtxos').mockResolvedValue([currentUtxo])
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementation(
      async (_address, _input, options) => {
        if (options?.allowMigrationProtectedAssetTransfer) return SIGNATURE_BUDGET
        throw new Error('qbit_recovery_migration_signing_only')
      }
    )

    // A verified plain P2MR funding output classifies as asset-free, so the
    // migration escape stays closed and ordinary preflight rejects instead.
    getTxMock.mockResolvedValue({
      txid: inputTxid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
    })
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('qbit_recovery_migration_signing_only')
    expect(getTxMock).toHaveBeenCalledWith(inputTxid)

    getTxMock.mockRejectedValue(new QbitApiError('network', 'explorer offline'))
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('explorer offline')

    getTxMock.mockResolvedValue({
      txid: inputTxid,
      vin: [{ is_coinbase: false }],
      vout: [],
    })
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow(`could not resolve outpoint ${inputTxid}:0`)

    getTxMock.mockResolvedValue({
      txid: '97'.repeat(32),
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
    })
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('invalid transaction')

    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(1)
  })

  it('authorizes a protected transfer that adds an ordinary wallet input for fees', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const protectedTxid = '98'.repeat(32)
    const ordinaryTxid = '99'.repeat(32)
    const psbtHex = psbtHexWithDataOutputs(account, [], [protectedTxid, ordinaryTxid])
    const currentUtxo = (txid: string, satoshis = 50_000) => ({
      txid,
      vout: 0,
      satoshis,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    })
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrating',
      migration: { network: 'regtest' },
    } as any)
    const getQbitUtxos = vi.spyOn(wallet, 'getQbitUtxos').mockResolvedValue([
      currentUtxo(protectedTxid),
      currentUtxo(ordinaryTxid),
    ])
    const assetCoverage = vi
      .spyOn(wallet as any, 'getQbitProtectedAssetCoverage')
      .mockResolvedValue({
        assetCount: 1,
        protectedOutpoints: new Set([`${protectedTxid}:0`]),
      })
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementation(
      async (_address, _input, options) => {
        if (options?.allowMigrationProtectedAssetTransfer) return SIGNATURE_BUDGET
        throw new Error('qbit_recovery_migration_signing_only')
      }
    )

    const mixedTransfer = await wallet.prepareQbitProviderPsbt(psbtHex, {
      chain: ChainType.QBIT_REGTEST,
    })

    expect(assetCoverage).toHaveBeenCalledWith([
      expect.objectContaining({ txid: protectedTxid, vout: 0 }),
      expect.objectContaining({ txid: ordinaryTxid, vout: 0 }),
    ])
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) }),
      { allowMigrationProtectedAssetTransfer: true }
    )
    expect(mixedTransfer.action).toMatchObject({
      description: 'qbit_recovery_migration_signing_only',
      details: [
        {
          label: 'qbit_recovery_migrating_title',
          value: 1,
          type: 'TEXT',
          warning: true,
        },
      ],
    })

    // A tiny protected input cannot authorize draining ordinary value: the
    // 10k external output exceeds the 500-sat protected input, so the escape
    // stays closed and preflight runs without the transfer authorization.
    getQbitUtxos.mockResolvedValue([
      currentUtxo(protectedTxid, 500),
      currentUtxo(ordinaryTxid),
    ])
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('qbit_recovery_migration_signing_only')
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenLastCalledWith(
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) })
    )

    getQbitUtxos.mockResolvedValue([currentUtxo(protectedTxid), currentUtxo(ordinaryTxid)])
    assetCoverage.mockRejectedValueOnce(
      new Error(`Qbit protected-asset lookup could not resolve outpoint ${ordinaryTxid}:0`)
    )
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('could not resolve outpoint')
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(2)
  })

  it('keeps the migration signing escape from authorizing a PSBT with a non-signable input', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const externalAccount = p2mrAccount('33'.repeat(32))
    const psbtHex = psbtHexWithDataOutputs(
      account,
      [],
      ['98'.repeat(32), '99'.repeat(32)],
      [account, externalAccount]
    )
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrating',
      migration: { network: 'regtest' },
    } as any)
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementation(
      async (_address, _input, options) => {
        if (options?.allowMigrationProtectedAssetTransfer) return SIGNATURE_BUDGET
        throw new Error('qbit_recovery_migration_signing_only')
      }
    )
    const getQbitUtxos = vi.spyOn(wallet, 'getQbitUtxos')
    const assetCoverage = vi.spyOn(wallet as any, 'getQbitProtectedAssetCoverage')

    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow('qbit_recovery_migration_signing_only')

    expect(getQbitUtxos).not.toHaveBeenCalled()
    expect(assetCoverage).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) })
    )
  })

  it("returns a PSBT with another signer's input signed but unfinalized unless finalizing is requested", async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const otherSigner = p2mrAccount('33'.repeat(32))
    const psbtHex = psbtHexWithDataOutputs(
      account,
      [],
      ['98'.repeat(32), '99'.repeat(32)],
      [account, otherSigner]
    )
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue(undefined as any)

    // An explicit finalize the wallet cannot complete is refused before the
    // approval opens and before the signature budget preflight.
    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, {
        chain: ChainType.QBIT_REGTEST,
        autoFinalized: true,
      })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
      message: expect.stringContaining('input 1'),
    })
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()

    const toSignData = await wallet.prepareQbitProviderPsbt(psbtHex, {
      chain: ChainType.QBIT_REGTEST,
    })
    expect(toSignData).toMatchObject({
      toSignInputs: [{ index: 0, publicKey: account.pubkey }],
      autoFinalized: false,
    })

    const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(toSignData.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    // The spent signature comes back for the other signer to complete, where
    // finalizing the other signer's input used to throw after the counter moved.
    const result = await wallet.signPsbtV2(toSignData)
    const inputs = decodePsbt(parsePsbt(hexToBytes(result.psbtHex!))).inputs
    expect(inputs.map(input => input.finalized)).toEqual([false, false])
    expect(inputs.map(input => input.scriptSigs.length)).toEqual([1, 0])

    // Finalizing after signing still fails rather than return such a PSBT
    // as complete.
    await expect(wallet.signPsbtV2({ ...toSignData, autoFinalized: true })).rejects.toThrow(
      'input 1: no P2MR script signature to finalize'
    )
  })

  it('finalizes a provider PSBT by default only when signing completes every input', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const psbtHex = psbtHexWithDataOutputs(account, [], ['98'.repeat(32), '99'.repeat(32)])
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue(undefined as any)
    const prepare = (psbt: string, autoFinalized?: boolean) =>
      wallet.prepareQbitProviderPsbt(psbt, {
        chain: ChainType.QBIT_REGTEST,
        ...(autoFinalized === undefined ? {} : { autoFinalized }),
      })

    await expect(prepare(psbtHex)).resolves.toMatchObject({ autoFinalized: true })
    await expect(prepare(psbtHex, true)).resolves.toMatchObject({ autoFinalized: true })
    await expect(prepare(psbtHex, false)).resolves.toMatchObject({ autoFinalized: false })

    // An unrelated signature on the account's own input: finalize builds the
    // witness qbit Core builds, from the account's own leaf and signature,
    // and drops the signature for another (pubkey, leaf hash) pair.
    const withUnrelatedSignature = parsePsbt(hexToBytes(psbtHex))
    const unrelatedPubkey = hexToBytes('44'.repeat(32))
    withUnrelatedSignature.inputs[0]!.push(
      encodeP2mrPsbtScriptSigField(
        unrelatedPubkey,
        p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(unrelatedPubkey)),
        new Uint8Array(PQC_SIGNATURE_BYTES).fill(2)
      )
    )
    const junkPsbtHex = bytesToHex(serializePsbt(withUnrelatedSignature))
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockClear()

    await expect(prepare(junkPsbtHex)).resolves.toMatchObject({ autoFinalized: true })
    await expect(prepare(junkPsbtHex, false)).resolves.toMatchObject({ autoFinalized: false })
    await expect(prepare(junkPsbtHex, true)).resolves.toMatchObject({ autoFinalized: true })
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(3)
  })

  it('stops automatic migration before sweeping an outpoint with protected assets', async () => {
    const wallet = new WalletController()
    const sourceAccount = p2mrAccount('31'.repeat(32))
    const destinationAccount = p2mrAccount('32'.repeat(32))
    const sourceKeyring = {
      index: 2,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [sourceAccount],
    }
    const destinationKeyring = {
      index: 3,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [destinationAccount],
    }
    const state = {
      status: 'migrating',
      acknowledgement: 'accepted',
      addressDiscoveryComplete: true,
      migration: {
        destinationKeyringIndex: 3,
        destinationPubkey: destinationAccount.pubkey,
        destinationAddress: destinationAccount.address,
        network: 'regtest',
        plans: [],
      },
    }
    installQbitDestinationRawKeyring(destinationAccount)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring,
      anchor: sourceAccount,
      state,
      network: 'regtest' as const,
      destination: destinationKeyring,
      destinationKeyringIndex: 3,
    })
    const protectedTxid = '59'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: protectedTxid,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      },
    ])
    getTxMock.mockResolvedValue({
      txid: protectedTxid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: sourceAccount.p2mr.scriptPubKey }],
    })
    const assetCoverage = vi
      .spyOn(wallet as any, 'getQbitProtectedAssetCoverage')
      .mockResolvedValue({
        assetCount: 1,
        protectedOutpoints: new Set([`${protectedTxid}:0`]),
      })

    // The stable code is the UI contract; the message stays log-only.
    const expectProtectedAssetRejection = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => {
          throw new Error('expected a protected-asset rejection')
        },
        caught => caught as WalletError
      )
      expect(error).toBeInstanceOf(WalletError)
      expect(error.code).toBe(ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS)
    }

    await expectProtectedAssetRejection(wallet.prepareQbitRecoveryMigration(2, 1))

    // Coverage that cannot be established keeps the sweep fail-closed rather
    // than treating the unclassified outpoint as ordinary funds.
    assetCoverage.mockRejectedValueOnce(
      new Error(`Qbit protected-asset lookup could not resolve outpoint ${protectedTxid}:0`)
    )
    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).rejects.toThrow(
      'could not resolve outpoint'
    )

    expect(assetCoverage).toHaveBeenCalledTimes(2)
    expect(assetCoverage).toHaveBeenLastCalledWith([
      expect.objectContaining({ txid: protectedTxid, vout: 0 }),
    ])
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  })

  it.each([
    [
      'non-P2MR',
      {
        ...p2mrAccount(),
        p2mr: undefined,
      },
    ],
    [
      'watch-only',
      {
        ...p2mrAccount(),
        type: KeyringType.WatchAddressKeyring,
      },
    ],
    [
      'unsupported cold-wallet',
      {
        ...p2mrAccount(),
        type: KeyringType.ColdWalletKeyring,
      },
    ],
  ])('rejects a %s account before preparing a provider PSBT', async (_label, account) => {
    const wallet = new WalletController()
    const psbtHex = psbtHexWithDataOutputs(p2mrAccount(), [])
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    await expect(
      wallet.prepareQbitProviderPsbt(psbtHex, { chain: ChainType.QBIT_REGTEST })
    ).rejects.toThrow()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  })

  it('builds a P2MR proof for the normalized account and preserves meaningful whitespace', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const staleAccount = p2mrAccount('22'.repeat(32))
    const message = ' \nwallet-controller P2MR message\t '
    const expectedDatasigHash = qbitDataSigPqcHash(qbitWalletMessageHash(message))
    const signature = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x6a)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(staleAccount as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({ accounts: [account] } as any)
    vi.mocked(keyringService.signP2mrMessageWithCounter).mockResolvedValue({
      pubkey: account.pubkey,
      cacheKey: 'cache-key',
      signature,
      cached: false,
      counter: null,
    })

    const result = await wallet.signMessage({ text: message, type: SignMessageType.P2MR })

    expect(keyringService.signP2mrMessageWithCounter).toHaveBeenCalledWith(
      account.address,
      expectedDatasigHash,
      undefined
    )
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalledWith(
      staleAccount.address,
      expectedDatasigHash,
      undefined
    )
    expect(keyringService.signMessage).not.toHaveBeenCalled()
    expect(result.proof).toMatchObject({
      type: 'p2mr-message',
      version: 1,
      address: account.address,
      message_hash: bytesToHex(qbitWalletMessageHash(message)),
      datasig_hash: bytesToHex(expectedDatasigHash),
      pubkey: account.pubkey,
      signature: bytesToHex(signature),
      leaf_script: account.p2mr.leafScript,
      control_block: 'c1',
    })
    expect(
      verifyP2mrMessageProof(
        message,
        result.proof,
        (pubkey, digest, proofSignature) =>
          bytesToHex(pubkey) === account.pubkey &&
          bytesToHex(digest) === bytesToHex(expectedDatasigHash) &&
          bytesToHex(proofSignature) === bytesToHex(signature),
        { expectedAddress: account.address }
      )
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(message.trim(), result.proof, () => true, {
        expectedAddress: account.address,
      })
    ).toBe(false)
  })

  it('preflights P2MR message batches for the normalized account when preferences are stale', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const staleAccount = p2mrAccount('22'.repeat(32))
    const messages = ['first P2MR message', 'second P2MR message', 'first P2MR message']
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(staleAccount as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({ accounts: [account] } as any)

    await expect(wallet.preflightP2mrMessageSigning(messages)).resolves.toEqual({
      accountAddress: account.address,
      signatureBudget: SIGNATURE_BUDGET,
    })

    expect(keyringService.preflightP2mrMessageSigning).toHaveBeenCalledWith(
      account.address,
      messages.map(message => qbitDataSigPqcHash(qbitWalletMessageHash(message)))
    )
    expect(keyringService.preflightP2mrMessageSigning).not.toHaveBeenCalledWith(
      staleAccount.address,
      expect.anything()
    )
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only P2MR messages before keyring preflight or signing', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const message = ' \n\t '
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    await expect(wallet.preflightP2mrMessageSigning([message])).rejects.toThrow(
      'Invalid message length'
    )
    await expect(wallet.signMessage({ text: message, type: SignMessageType.P2MR })).rejects.toThrow(
      'Invalid message length'
    )
    await expect(wallet.signP2mrMessage(message)).rejects.toThrow('Invalid message length')

    expect(keyringService.preflightP2mrMessageSigning).not.toHaveBeenCalled()
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('rejects a preflighted P2MR batch after an account switch without consuming the new account counter', async () => {
    const wallet = new WalletController()
    const preflightedAccount = p2mrAccount()
    const switchedAccount = p2mrAccount('22'.repeat(32))
    const message = 'account-bound P2MR message'
    vi.spyOn(wallet, 'getCurrentAccount')
      .mockResolvedValueOnce(preflightedAccount as any)
      .mockResolvedValueOnce(switchedAccount as any)

    const { accountAddress: p2mrAccountAddress } = await wallet.preflightP2mrMessageSigning([
      message,
    ])

    await expect(
      wallet.signMessage({
        text: message,
        type: SignMessageType.P2MR,
        p2mrAccountAddress,
      })
    ).rejects.toThrow('P2MR signing account changed after approval')
    expect(keyringService.preflightP2mrMessageSigning).toHaveBeenCalledWith(
      preflightedAccount.address,
      [qbitDataSigPqcHash(qbitWalletMessageHash(message))]
    )
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('rejects corrupted P2MR account metadata before consuming a signature counter', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    account.p2mr.leafScript = `20${'33'.repeat(32)}b3`
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    await expect(
      wallet.signMessage({ text: 'do not sign', type: SignMessageType.P2MR })
    ).rejects.toThrow(/leaf script metadata mismatch/)
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('keeps whitespace-only ECDSA signing on the existing generic keyring path', async () => {
    const wallet = new WalletController()
    const account = {
      ...p2mrAccount(),
      type: KeyringType.HdKeyring,
      p2mr: undefined,
    }
    const message = ' \n\t '
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(keyringService.signMessage).mockResolvedValue('ecdsa-signature')

    await expect(
      wallet.signMessage({ text: message, type: SignMessageType.ECDSA })
    ).resolves.toEqual({ signature: 'ecdsa-signature' })
    expect(keyringService.signMessage).toHaveBeenCalledWith(account.pubkey, account.type, message)
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('keeps whitespace-only BIP-322 signing on the existing transaction helper path', async () => {
    const wallet = new WalletController()
    const account = {
      ...p2mrAccount(),
      type: KeyringType.HdKeyring,
      p2mr: undefined,
    }
    const message = ' \n\t '
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    signMessageOfBIP322SimpleMock.mockResolvedValue('bip322-signature')

    await expect(
      wallet.signMessage({ text: message, type: SignMessageType.BIP322_SIMPLE })
    ).resolves.toEqual({ signature: 'bip322-signature' })
    expect(signMessageOfBIP322SimpleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message,
        address: account.address,
      })
    )
    expect(keyringService.signMessage).not.toHaveBeenCalled()
    expect(keyringService.signP2mrMessageWithCounter).not.toHaveBeenCalled()
  })

  it('allows qbit P2MR sends without enabling unsupported generic signing paths', () => {
    expect(canCreateQbitSendRequest({ type: SharedKeyringType.QbitHdKeyring, p2mr: {} })).toBe(true)
    expect(canCreateQbitSendRequest({ type: SharedKeyringType.QbitHdKeyring })).toBe(false)
    expect(
      canCreateQbitSendRequest({ type: SharedKeyringType.WatchAddressKeyring, p2mr: {} })
    ).toBe(false)
    expect(canCreateQbitSendRequest({ type: SharedKeyringType.HdKeyring })).toBe(false)
    expect(canCreateQbitSendRequest({ type: SharedKeyringType.HdKeyring, p2mr: {} })).toBe(true)
    expect(canCreateQbitSendRequest(null)).toBe(false)
  })

  it('rejects qbit recipient amounts below P2MR dust before signing', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const qbitUtxos = [
      {
        txid: 'ee'.repeat(32),
        vout: 0,
        satoshis: 50_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
    ]

    await expect(
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 2_854,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos,
      })
    ).rejects.toThrow(/2855/)

    const boundary = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: QBIT_P2MR_DUST,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos,
    })
    expect(decodePsbt(parsePsbt(hexToBytes(boundary.psbtHex))).outputs[0]!.value).toBe(
      BigInt(QBIT_P2MR_DUST)
    )
  })

  it('continues past an over-ceiling no-change candidate when a later UTXO enables safe change', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    const result = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 61_829_900,
      feeRate: 10_000,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'eb'.repeat(32),
          vout: 0,
          satoshis: 100_000_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
        {
          txid: 'ec'.repeat(32),
          vout: 1,
          satoshis: 50_000_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    expect(result).toMatchObject({
      estimatedFee: 76_220_000,
      estimatedVsize: 7_622,
      inputCount: 2,
      changeDroppedSats: 0,
      maximumTotalFee: 76_220_000,
    })
    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.inputs).toHaveLength(2)
    expect(summary.outputs.map(output => output.value)).toEqual([61_829_900n, 11_950_100n])
  })

  it('spends the output that covers a send instead of the smaller outputs listed before it', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxo = (index: number, satoshis: number) => ({
      txid: index.toString(16).padStart(64, '0'),
      vout: 0,
      satoshis,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    })
    // Probe F: the explorer lists twenty 5,000-bit payouts before one
    // 1,000,000-bit output.
    const large = utxo(21, 1_000_000)
    const qbitUtxos = [...Array.from({ length: 20 }, (_, index) => utxo(index + 1, 5_000)), large]
    const send = (feeRate: number) =>
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 50_000,
        feeRate,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos,
      })

    const atRelayFloor = await send(1)
    expect(atRelayFloor).toMatchObject({ inputCount: 1, estimatedFee: 3_860 })
    expect(
      decodePsbt(parsePsbt(hexToBytes(atRelayFloor.psbtHex))).inputs.map(input =>
        bytesToHex(input.prevout.txid)
      )
    ).toEqual([reverseTxid(large.txid)])
    expectPreviewToMatchFinalizedTransaction(atRelayFloor)

    // At 50 bits/vB each small payout costs more than it carries.
    await expect(send(50)).resolves.toMatchObject({ inputCount: 1, estimatedFee: 193_000 })
  })

  it('refuses a send that needs more than 106 inputs before any signature is preflighted', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const qbitUtxos = Array.from({ length: 150 }, (_, index) => ({
      txid: (index + 1).toString(16).padStart(64, '0'),
      vout: 0,
      satoshis: 10_000,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }))
    const send = (amount: number) =>
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos,
      })

    // Probe B: 700,000 needs 113 of these inputs, over qbit Core's 400,000 WU.
    const largestSend = 106 * 10_000 - 398_827
    await expect(send(700_000)).rejects.toThrow(
      `Amount needs more than 106 inputs, over the standard transaction size; at most ${largestSend} sats can be sent in one transaction.`
    )
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()

    const largest = await send(largestSend)
    expect(largest).toMatchObject({ inputCount: 106, estimatedVsize: 398_827 })
  })

  it('sends the 106 largest outputs on send-all and reports the outputs left behind', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const utxo = (index: number, satoshis: number) => ({
      txid: (index + 1).toString(16).padStart(64, '0'),
      vout: 0,
      satoshis,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    })
    // Probe B: 150 outputs, the 44 smallest listed first.
    const qbitUtxos = [
      ...Array.from({ length: 44 }, (_, index) => utxo(index, 4_000)),
      ...Array.from({ length: 106 }, (_, index) => utxo(44 + index, 20_000)),
    ]

    const result = await wallet.createSendAllQbitPsbt({
      to: recipientAddress(),
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos,
    })

    expect(result).toMatchObject({
      inputCount: 106,
      estimatedVsize: 398_827,
      estimatedFee: 398_827,
      leftBehindInputCount: 44,
      leftBehindSats: 44 * 4_000,
    })
    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.inputs.every(input => input.witnessUtxo?.value === 20_000n)).toBe(true)
    expect(summary.outputs.map(output => output.value)).toEqual([BigInt(106 * 20_000 - 398_827)])
    expectPreviewToMatchFinalizedTransaction(result)
  })

  it('blocks rates and folded total fees above the exact-size safety ceiling', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const qbitUtxos = [
      {
        txid: 'ed'.repeat(32),
        vout: 0,
        satoshis: 100_000_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
    ]

    await expect(
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 10_000,
        feeRate: 10_001,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos,
      })
    ).rejects.toThrow(/between 1 and 10000/)

    await expect(
      wallet.createSendQbitPsbt({
        to: recipientAddress(),
        amount: 61_829_900,
        feeRate: 10_000,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos,
      })
    ).rejects.toThrow('Fee exceeds the wallet safety maximum')
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  })

  it('preserves memo sends as qbit OP_RETURN outputs', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    const result = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      memo: 'hello',
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'ff'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.outputs).toHaveLength(3)
    expect(summary.outputs[1]!.value).toBe(0n)
    expect(summary.outputs[1]!.scriptPubKey[0]).toBe(0x6a)

    const decoded = await wallet.decodePsbt(result.psbtHex, 'https://example.test')
    expect(decoded.outputInfos[1]).toMatchObject({
      type: 'op_return',
      address: '',
      value: 0,
      opReturn: {
        scriptPubKeyHex: '6a0568656c6c6f',
        chunks: [
          {
            pushHeaderHex: '05',
            dataHex: '68656c6c6f',
            dataByteLength: 5,
            dataStartByte: 2,
            dataEndByte: 7,
            utf8Preview: 'hello',
          },
        ],
      },
    })
  })

  it('treats uppercase qbit memo hex as bytes', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    const result = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      memo: 'ABCD',
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '12'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(bytesToHex(summary.outputs[1]!.scriptPubKey)).toBe('6a02abcd')

    const decoded = await wallet.decodePsbt(result.psbtHex, 'https://example.test')
    expect(decoded.outputInfos[1]).toMatchObject({
      type: 'op_return',
      opReturn: {
        scriptPubKeyHex: '6a02abcd',
        chunks: [
          {
            pushHeaderHex: '02',
            dataHex: 'abcd',
            dataByteLength: 2,
            dataStartByte: 2,
            dataEndByte: 4,
          },
        ],
      },
    })
    expect(decoded.outputInfos[1]!.opReturn?.chunks[0]!.utf8Preview).toBeUndefined()
  })

  it('preserves multiple pushes and warns on unusual OP_RETURN scripts during qbit decode', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const psbtHex = psbtHexWithDataOutputs(account, [
      hexToBytes('6a01aa02bbcc'),
      hexToBytes('6a51'),
    ])

    const decoded = await wallet.decodePsbt(psbtHex, 'https://example.test')

    expect(decoded.outputInfos[0]).toMatchObject({
      address: recipientAddress(),
      value: 10_000,
    })
    expect(decoded.outputInfos[1]).toMatchObject({
      type: 'op_return',
      opReturn: {
        scriptPubKeyHex: '6a01aa02bbcc',
        chunks: [
          {
            pushHeaderHex: '01',
            dataHex: 'aa',
            dataStartByte: 2,
            dataEndByte: 3,
          },
          {
            pushHeaderHex: '02',
            dataHex: 'bbcc',
            dataStartByte: 4,
            dataEndByte: 6,
          },
        ],
      },
    })
    expect(decoded.outputInfos[2]).toMatchObject({
      type: 'op_return',
      opReturn: {
        scriptPubKeyHex: '6a51',
        chunks: [],
        decodeWarning: 'non-pushdata-opcode',
      },
    })
  })

  it('analyzes Qbit P2MR PSBTs with the Qbit decoder', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)

    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: '34'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    const summary = await wallet.analyzeLocalPsbts([toSignData])

    expect(summary.parseErrorCount).toBe(0)
    expect(summary.completedCount).toBe(1)
    expect(summary.items[0]).toMatchObject({
      inputCount: 1,
      outputCount: 2,
      parseError: false,
      isCompleted: true,
    })
    expect(summary.totalFee).toBe(toSignData.estimatedFee)
  })

  it('routes qbit P2MR signing through the counter-safe path and immediately refreshes its displayed counter', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'bb'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(toSignData.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    const refreshedAccount = {
      ...account,
      p2mr: {
        ...account.p2mr,
        signatureCounter: {
          ...account.p2mr.signatureCounter,
          count: 1,
          remaining: account.p2mr.signatureCounter.remaining - 1,
        },
      },
    }
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(refreshedAccount as any)
    const emit = vi.spyOn(bgEventBus, 'emit')

    const result = await wallet.signPsbtV2(toSignData)

    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({
        psbt: expect.any(Object),
        keys,
      }),
      SIGNATURE_BUDGET,
      false
    )
    expect(emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: refreshedAccount,
    })
    expect(emit.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(keyringService.signP2mrPsbtWithCounter).mock.invocationCallOrder[0]!
    )
    expect(decodePsbt(parsePsbt(hexToBytes(result.psbtHex!))).inputs[0]!.finalized).toBe(true)
    // The identity fixed when the send was built comes back unchanged and
    // matches the txid the finalized bytes will broadcast under.
    expect(result.qbitBroadcastIdentity).toEqual(toSignData.qbitBroadcastIdentity)
    expect(result.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: transactionCore.Transaction.fromBuffer(
        Buffer.from(extractP2mrTransaction(parsePsbt(hexToBytes(result.psbtHex!))))
      ).getId(),
    })
    // A send the wallet built for its own confirm screen is reserved at
    // signing exactly like a provider send: the wallet mints the claim the
    // confirm screen retains with the bytes, so no other send flow can select
    // or sign these inputs while the signed bytes are still retryable.
    const walletClaim = {
      chain: ChainType.QBIT_REGTEST,
      address: account.address,
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: toSignData.qbitBroadcastIdentity!.txid,
      outpoints: [{ txid: 'bb'.repeat(32), vout: 0 }],
      // Not a fee bump: the claim takes over no other transaction's inputs.
      replaces: null,
    }
    expect(result.qbitSendBroadcastClaim).toEqual(walletClaim)
    // Signed outside any UI port (as here), the wallet claim has no owner.
    expect(qbitSendGuardService.runWithBroadcastClaim).toHaveBeenCalledWith(
      walletClaim,
      expect.any(Function),
      undefined
    )
    expect(qbitSendGuardService.runWithNoOverlap).not.toHaveBeenCalled()
    emit.mockRestore()
  })

  it('retains an exact normal-send claim through local signing for its later broadcast', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'ba'.repeat(32),
          vout: 1,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const providerContext = {
      origin: 'https://otc.example',
      account: 'qbrt1zprovidercontextchanged',
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }
    toSignData.providerContext = providerContext
    toSignData.qbitSendBroadcastClaim = wallet.createQbitSendBroadcastClaim(
      toSignData.psbtHex,
      providerContext
    )
    const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(toSignData.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(6),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    // Signed in the notification window the dapp's approval opened.
    const result = await wallet.runForUiPort('notification:1', () =>
      wallet.signPsbtV2(toSignData)
    )

    expect(toSignData.qbitSendBroadcastClaim.address).toBe(account.address)
    // A provider claim is never owned by the UI port that signs it: it is
    // filed under the provider request that approved it, which decides it
    // however the approval window ends.
    expect(qbitSendGuardService.runWithProviderBroadcastClaim).toHaveBeenCalledWith(
      toSignData.qbitSendBroadcastClaim,
      expect.any(Function)
    )
    expect(qbitSendGuardService.runWithBroadcastClaim).not.toHaveBeenCalled()
    expect(qbitSendGuardService.runWithNoOverlap).not.toHaveBeenCalled()
    expect(result.qbitSendBroadcastClaim).toEqual(toSignData.qbitSendBroadcastClaim)
    expect(result.qbitBroadcastIdentity).toEqual({
      chain: toSignData.qbitSendBroadcastClaim.chain,
      txid: toSignData.qbitSendBroadcastClaim.txid,
    })
  })

  it('refuses a request whose creation identity no longer holds, before any signature is consumed', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'bc'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    expect(toSignData.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: unsignedTxid(toSignData.psbtHex),
    })

    // Another wallet window switched network while the confirmation screen
    // was open. The inputs exist only on regtest, so signing must not spend
    // a one-time signature on bytes that would then be pinned to mainnet.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await expect(wallet.signPsbtV2(toSignData)).rejects.toThrow(
      'Qbit network changed since the transaction was created'
    )

    // An identity that names another transaction is not trusted either.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    await expect(
      wallet.signPsbtV2({
        ...toSignData,
        qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: 'ff'.repeat(32) },
      })
    ).rejects.toThrow('invalid Qbit broadcast identity')

    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(qbitSendGuardService.runWithNoOverlap).not.toHaveBeenCalled()
  })

  it('rejects signing when the overlap guard reports a claimed input', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'bc'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    // The wallet's own send registers its claim atomically with the overlap
    // check, so a conflict surfaces from that registration.
    vi.mocked(qbitSendGuardService.runWithBroadcastClaim).mockRejectedValueOnce(
      new Error('Qbit transaction spends an input claimed by an approved send')
    )

    await expect(wallet.signPsbtV2(toSignData)).rejects.toThrow('claimed by an approved send')
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('keeps a provider signing request on the overlap check without minting a wallet claim', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'bd'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    // A dapp signing request without a send claim: the signed bytes go back
    // to the dapp, which broadcasts them itself through the claim-less
    // pushTx, so a wallet-owned claim here would only block that broadcast.
    toSignData.providerContext = {
      origin: 'https://otc.example',
      account: account.address,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }
    const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(toSignData.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(8),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    const result = await wallet.signPsbtV2(toSignData)

    expect(result.qbitSendBroadcastClaim).toBeUndefined()
    expect(result.qbitBroadcastIdentity).toEqual(toSignData.qbitBroadcastIdentity)
    // The transaction being signed travels with the check, so a recent
    // broadcast of the same transaction does not refuse it.
    expect(qbitSendGuardService.runWithNoOverlap).toHaveBeenCalledWith(
      ChainType.QBIT_REGTEST,
      [{ txid: 'bd'.repeat(32), vout: 0 }],
      expect.any(Function),
      expect.stringMatching(/^[0-9a-f]{64}$/)
    )
    expect(qbitSendGuardService.runWithBroadcastClaim).not.toHaveBeenCalled()
  })

  it('reviews the exact OP_RETURN output passed to signing and preserves unsigned outputs', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipientAddress(),
      amount: 10_000,
      feeRate: 1,
      memo: 'ABCD',
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'bc'.repeat(32),
          vout: 0,
          satoshis: 50_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })
    const keys = toSignData.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const unsignedOutputs = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).outputs.map(
      output => ({
        value: output.value.toString(),
        scriptPubKeyHex: bytesToHex(output.scriptPubKey),
      })
    )
    const reviewed = await wallet.decodePsbt(toSignData.psbtHex, 'https://example.test')

    expect(reviewed.outputInfos[1]).toMatchObject({
      type: 'op_return',
      opReturn: { scriptPubKeyHex: unsignedOutputs[1]!.scriptPubKeyHex },
    })

    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(toSignData.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(8),
    })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValue({
      psbt: signed.psbt,
      signed: signed.signed,
      counterResults: [],
    })
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)

    const signedData = await wallet.signPsbtV2(toSignData)
    const psbtPassedToSigning = vi.mocked(keyringService.signP2mrPsbtWithCounter).mock.calls[0]![1]
      .psbt
    const signingOutputs = decodePsbt(psbtPassedToSigning).outputs.map(output => ({
      value: output.value.toString(),
      scriptPubKeyHex: bytesToHex(output.scriptPubKey),
    }))
    const signedOutputs = decodePsbt(parsePsbt(hexToBytes(signedData.psbtHex!))).outputs.map(
      output => ({
        value: output.value.toString(),
        scriptPubKeyHex: bytesToHex(output.scriptPubKey),
      })
    )

    expect(signingOutputs).toEqual(unsignedOutputs)
    expect(signedOutputs).toEqual(unsignedOutputs)
  })

  it('builds and exactly prices a qbit send-all memo through the counter-safe path', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const memo = 'send-all memo'

    const result = await wallet.createSendAllQbitPsbt({
      to: recipientAddress(),
      feeRate: 1,
      enableRBF: false,
      memo,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [
        {
          txid: 'cc'.repeat(32),
          vout: 0,
          satoshis: 30_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
        {
          txid: 'dd'.repeat(32),
          vout: 1,
          satoshis: 30_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ],
    })

    expect(sendAllQbitMock).not.toHaveBeenCalled()
    expect(result.toSignInputs).toEqual([
      { index: 0, publicKey: account.pubkey },
      { index: 1, publicKey: account.pubkey },
    ])
    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.inputs).toHaveLength(2)
    expect(summary.outputs).toHaveLength(2)
    expect(summary.inputs[0]!.sequence).toBe(0xffffffff)
    expect(summary.outputs[0]!.value).toBe(BigInt(60_000 - result.estimatedFee!))
    const memoBytes = new TextEncoder().encode(memo)
    expect(bytesToHex(summary.outputs[1]!.scriptPubKey)).toBe(
      `6a${memoBytes.length.toString(16).padStart(2, '0')}${bytesToHex(memoBytes)}`
    )
    expect(summary.outputs[1]!.value).toBe(0n)

    const leaf = summary.inputs[0]!.leafScripts[0]!
    const exactEstimate = estimateQbitP2mrTransaction({
      inputCount: summary.inputs.length,
      outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
      leafScriptLength: leaf.script.length,
      controlBlockLength: leaf.controlBlock.length,
      feeRate: 1,
    })
    expect(result.estimatedFee).toBe(exactEstimate.fee)
    expect(result.signatureBudget).toEqual(SIGNATURE_BUDGET)
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledWith(
      account.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) })
    )

    const keys = result.qbitP2mrSigningKeys!.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: hexToBytes(key.publicKey),
      leafHash: hexToBytes(key.leafHash),
    }))
    const signed = signP2mrPsbt({
      psbt: parsePsbt(hexToBytes(result.psbtHex)),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(8),
    })
    expect(extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt)).length).toBe(exactEstimate.vsize)
  })

  it('excludes reserved outpoints from explicit qbit send-all selection', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const reservedTxid = 'ca'.repeat(32)
    const availableTxid = 'db'.repeat(32)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set([`${reservedTxid}:0`])
    )

    const result = await wallet.createSendAllQbitPsbt({
      to: recipientAddress(),
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [reservedTxid, availableTxid].map(txid => ({
        txid,
        vout: 0,
        satoshis: 50_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      })),
    })

    const summary = decodePsbt(parsePsbt(hexToBytes(result.psbtHex)))
    expect(summary.inputs).toHaveLength(1)
    expect(summary.inputs[0]?.prevout.txid).toEqual(hexToBytes(reverseTxid(availableTxid)))
  })

  it('serializes migration destination creation with chain changes', async () => {
    const wallet = new WalletController()
    let releaseCreation!: () => void
    const creationGate = new Promise<void>(resolve => {
      releaseCreation = resolve
    })
    let reportCreationStarted!: () => void
    const creationStarted = new Promise<void>(resolve => {
      reportCreationStarted = resolve
    })
    vi.spyOn(wallet as any, 'performCreateQbitRecoveryMigrationWallet').mockImplementation(
      async () => {
        reportCreationStarted()
        await creationGate
        return {
          status: 'migrating',
          acknowledgement: 'accepted',
          counterConfidence: 'chain-floor-only',
          knownOnChainSignatures: 1,
        }
      }
    )
    const performSetChainType = vi
      .spyOn(wallet as any, 'performSetChainType')
      .mockResolvedValue(undefined)

    const creation = wallet.createQbitRecoveryMigrationWallet({
      sourceKeyringIndex: 2,
      mnemonic: 'fresh migration mnemonic',
      hdPath: '',
      passphrase: '',
    })
    await creationStarted
    const networkChange = wallet.setChainType(ChainType.QBIT_TESTNET4)
    await Promise.resolve()
    expect(performSetChainType).not.toHaveBeenCalled()

    releaseCreation()
    await creation
    await networkChange
    expect(performSetChainType).toHaveBeenCalledTimes(1)
  })

  it('preflights persisted recovery migration plans in stable batches', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const plans: any[] = Array.from({ length: 65 }, (_value, index) => ({
      ...fixture.vaultState.migration.plans[0],
      id: `${fixture.sourceAccount.pubkey}:${index}`,
      status: 'prepared',
      signedPsbtHex: undefined,
      txid: undefined,
    }))
    const vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans },
    }
    const publicState = () => ({
      status: 'migrating' as const,
      acknowledgement: 'accepted' as const,
      counterConfidence: 'chain-floor-only' as const,
      knownOnChainSignatures: 4,
      migration: {
        destinationKeyringIndex: 3,
        destinationAddress: fixture.destinationAccount.address,
        network: 'regtest' as const,
        plans: plans.map(plan => ({
          id: plan.id,
          sourceAddress: plan.sourceAddress,
          destinationAddress: plan.destinationAddress,
          amount: plan.amount,
          fee: plan.fee,
          status: plan.status,
        })),
      },
    })
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => publicState())

    const firstBatch = await wallet.prepareQbitRecoveryMigration(2)

    expect(firstBatch.toSignDatas.map(data => data.qbitRecoveryMigration?.planId)).toEqual(
      plans.slice(0, 64).map(plan => plan.id)
    )
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(64)
    expect(vaultState.migration.plans).toHaveLength(65)
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).not.toHaveBeenCalled()

    plans.slice(0, 64).forEach(plan => {
      plan.status = 'signed'
    })
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockClear()

    const secondBatch = await wallet.prepareQbitRecoveryMigration(2)

    expect(secondBatch.toSignDatas.map(data => data.qbitRecoveryMigration?.planId)).toEqual([
      plans[64]!.id,
    ])
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(1)
    expect(vaultState.migration.plans).toHaveLength(65)
  })

  it('persists all newly prepared recovery plans before preflighting the first batch', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const sourceAccounts = Array.from({ length: 65 }, (_value, index) =>
      p2mrAccount((index + 128).toString(16).repeat(32))
    )
    const sourceKeyring = { ...fixture.sourceKeyring, accounts: sourceAccounts }
    const txidByAddress = new Map(
      sourceAccounts.map((account, index) => [
        account.address,
        (index + 1).toString(16).padStart(64, '0'),
      ])
    )
    const accountByTxid = new Map(
      sourceAccounts.map(account => [txidByAddress.get(account.address)!, account])
    )
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    const publicState = () => ({
      status: 'migrating' as const,
      acknowledgement: 'accepted' as const,
      counterConfidence: 'chain-floor-only' as const,
      knownOnChainSignatures: 4,
      migration: {
        destinationKeyringIndex: 3,
        destinationAddress: fixture.destinationAccount.address,
        network: 'regtest' as const,
        plans: vaultState.migration.plans.map((plan: any) => ({
          id: plan.id,
          sourceAddress: plan.sourceAddress,
          destinationAddress: plan.destinationAddress,
          amount: plan.amount,
          fee: plan.fee,
          status: plan.status,
        })),
      },
    })
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring,
      anchor: sourceAccounts[0],
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = {
          ...vaultState,
          migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
        }
        return publicState()
      }
    )
    // Contiguous allocation gives each of the 65 funded sources its own
    // destination account, so the destination must be able to grow.
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      fixture.destinationRawKeyring.activeIndexes.push(
        fixture.destinationRawKeyring.activeIndexes.length
      )
      return []
    })
    getAddressUtxosMock.mockImplementation(async address => [
      {
        txid: txidByAddress.get(address)!,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      },
    ])
    getTxMock.mockImplementation(async txid => {
      const account = accountByTxid.get(txid)!
      return {
        txid,
        vin: [{ is_coinbase: false }],
        vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
      }
    })

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)
    const persistedPlans = vaultState.migration.plans

    expect(persistedPlans).toHaveLength(65)
    expect(persistedPlans.every((plan: any) => plan.status === 'prepared')).toBe(true)
    expect(prepared.toSignDatas.map(data => data.qbitRecoveryMigration?.planId)).toEqual(
      persistedPlans.slice(0, 64).map((plan: any) => plan.id)
    )
    expect(keyringService.preflightP2mrPsbtSigning).toHaveBeenCalledTimes(64)
    expect(persistedPlans[64]).toMatchObject({
      id: `${sourceAccounts[64]!.pubkey}:0`,
      status: 'prepared',
    })
  })

  it('allocates contiguous destination indexes for sparse funded source accounts', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Sparse source: accounts at derivation indexes 0 and 2, nothing at 1.
    const sourceAccounts = [p2mrAccount('61'.repeat(32), 0), p2mrAccount('62'.repeat(32), 2)]
    const sourceKeyring = { ...fixture.sourceKeyring, accounts: sourceAccounts }
    const txidByAddress = new Map(
      sourceAccounts.map((account, index) => [
        account.address,
        (index + 1).toString(16).padStart(64, '0'),
      ])
    )
    const accountByTxid = new Map(
      sourceAccounts.map(account => [txidByAddress.get(account.address)!, account])
    )
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring,
      anchor: sourceAccounts[0],
      network: 'regtest' as const,
      state: vaultState,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = {
          ...vaultState,
          migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
        }
        return fixture.publicState(vaultState)
      }
    )
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      fixture.destinationRawKeyring.activeIndexes.push(
        fixture.destinationRawKeyring.activeIndexes.length
      )
      return []
    })
    getAddressUtxosMock.mockImplementation(async address => [
      {
        txid: txidByAddress.get(address)!,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      },
    ])
    getTxMock.mockImplementation(async txid => {
      const account = accountByTxid.get(txid)!
      return {
        txid,
        vin: [{ is_coinbase: false }],
        vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
      }
    })

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    const anchorDestination = await fixture.destinationRawKeyring.getQbitReceiveAccount(0)
    const nextDestination = await fixture.destinationRawKeyring.getQbitReceiveAccount(1)
    expect(vaultState.migration.plans).toHaveLength(2)
    expect(vaultState.migration.plans[0]).toMatchObject({
      sourceIndex: 0,
      destinationIndex: 0,
      destinationPubkey: anchorDestination.pubkey,
      destinationAddress: anchorDestination.addresses.regtest,
    })
    // Source index 2 pays the next contiguous destination index, never the
    // shared anchor address. Copying the source's index gap would let a fresh
    // gap-limit restore of the destination seed stop before the funds: only
    // funded accounts get plans, so the skipped index stays unfunded forever.
    expect(vaultState.migration.plans[1]).toMatchObject({
      sourceIndex: 2,
      destinationIndex: 1,
      destinationPubkey: nextDestination.pubkey,
      destinationAddress: nextDestination.addresses.regtest,
    })
    expect(nextDestination.addresses.regtest).not.toBe(anchorDestination.addresses.regtest)
    // The destination derived accounts up to the highest allocated index.
    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(1)
    // Swept destination indexes are reserved so the receive flow never hands
    // one of them out; the reservation commits atomically with the plans.
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(expect.any(String), 'regtest', expect.any(Array), {
      anchor: anchorDestination.pubkey,
      reserveIndexes: [0, 1],
      reuseIndexes: [],
    })
    expect(keyringService.markQbitReceiveIndexesIssued).not.toHaveBeenCalled()
    expect(
      prepared.toSignDatas.map(data => data.qbitRecoveryMigration?.destinationIndex)
    ).toEqual([0, 1])
    expect(prepared.toSignDatas.map(data => data.qbitRecoveryMigration?.destinationAddress)).toEqual(
      [anchorDestination.addresses.regtest, nextDestination.addresses.regtest]
    )
  })

  it('keeps earlier pairings and skips issued receive indexes when a reopened migration plans again', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const sourceAccounts = [p2mrAccount('63'.repeat(32), 0), p2mrAccount('64'.repeat(32), 5)]
    const sourceKeyring = { ...fixture.sourceKeyring, accounts: sourceAccounts }
    // An earlier pass swept source 0 into destination 0 and confirmed; the
    // destination's receive flow has since handed out index 1.
    const confirmedPlan = {
      ...fixture.vaultState.migration.plans[0]!,
      id: `${sourceAccounts[0]!.pubkey}:0`,
      sourcePubkey: sourceAccounts[0]!.pubkey,
      sourceAddress: sourceAccounts[0]!.address,
      destinationAddress: fixture.destinationAccount.address,
      destinationPubkey: fixture.destinationAccount.pubkey,
      status: 'confirmed' as const,
      sourceIndex: 0,
      destinationIndex: 0,
    }
    fixture.destinationRawKeyring.receiveIssuedIndexes.push(0, 1)
    const txidByAddress = new Map(
      sourceAccounts.map((account, index) => [
        account.address,
        (index + 1).toString(16).padStart(64, '0'),
      ])
    )
    const accountByTxid = new Map(
      sourceAccounts.map(account => [txidByAddress.get(account.address)!, account])
    )
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [confirmedPlan] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring,
      anchor: sourceAccounts[0],
      network: 'regtest' as const,
      state: vaultState,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = {
          ...vaultState,
          migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
        }
        return fixture.publicState(vaultState)
      }
    )
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      fixture.destinationRawKeyring.activeIndexes.push(
        fixture.destinationRawKeyring.activeIndexes.length
      )
      return []
    })
    getAddressUtxosMock.mockImplementation(async address => [
      {
        txid: txidByAddress.get(address)!,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 10 },
      },
    ])
    getTxMock.mockImplementation(async txid => {
      const account = accountByTxid.get(txid)!
      return {
        txid,
        vin: [{ is_coinbase: false }],
        vout: [{ value: 50_000, scriptpubkey: account.p2mr.scriptPubKey }],
      }
    })

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const anchorDestination = await fixture.destinationRawKeyring.getQbitReceiveAccount(0)
    const skipDestination = await fixture.destinationRawKeyring.getQbitReceiveAccount(2)
    expect(vaultState.migration.plans).toHaveLength(3)
    // A newly funded source that swept before keeps paying its own
    // destination account instead of scattering across the wallet.
    expect(vaultState.migration.plans[1]).toMatchObject({
      id: `${sourceAccounts[0]!.pubkey}:1`,
      sourceIndex: 0,
      destinationIndex: 0,
      destinationAddress: anchorDestination.addresses.regtest,
    })
    // A first-time source takes the next contiguous index that is neither
    // planned nor already handed out by the destination's receive flow.
    expect(vaultState.migration.plans[2]).toMatchObject({
      sourceIndex: 5,
      destinationIndex: 2,
      destinationPubkey: skipDestination.pubkey,
      destinationAddress: skipDestination.addresses.regtest,
    })
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(expect.any(String), 'regtest', expect.any(Array), {
      anchor: anchorDestination.pubkey,
      reserveIndexes: [2],
      reuseIndexes: [0],
    })
  })

  function gapAllocationFixture(sourceSeedByte: string) {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const sourceAccounts = [p2mrAccount(sourceSeedByte.repeat(32), 0)]
    const sourceKeyring = { ...fixture.sourceKeyring, accounts: sourceAccounts }
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring,
      anchor: sourceAccounts[0],
      network: 'regtest' as const,
      state: vaultState,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(async (_address, _network, plans) => {
      vaultState = {
        ...vaultState,
        migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
      }
      return fixture.publicState(vaultState)
    })
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      fixture.destinationRawKeyring.activeIndexes.push(
        fixture.destinationRawKeyring.activeIndexes.length
      )
      return []
    })
    const sourceTxid = '01'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      { txid: sourceTxid, vout: 0, value: 50_000, status: { confirmed: true, block_height: 10 } },
    ])
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: sourceAccounts[0]!.p2mr.scriptPubKey }],
    }))
    return { wallet, fixture, planned: () => vaultState.migration.plans }
  }

  it('funds the oldest handed-out index when skipping a full receive gap would strand the sweep', async () => {
    const { wallet, fixture, planned } = gapAllocationFixture('67')
    // The destination's receive flow handed out a full gap of addresses and
    // none of them ever saw funds; the next never-issued index sits exactly
    // past what a seed-only restore of the fresh seed scans, so skipping
    // every issued index would strand the sweep.
    fixture.destinationRawKeyring.receiveIssuedIndexes.push(
      ...Array.from({ length: 20 }, (_, index) => index)
    )

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const reusedDestination = await fixture.destinationRawKeyring.getQbitReceiveAccount(0)
    expect(planned()).toHaveLength(1)
    expect(planned()[0]).toMatchObject({
      sourceIndex: 0,
      destinationIndex: 0,
      destinationAddress: reusedDestination.addresses.regtest,
    })
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(expect.any(String), 'regtest', expect.any(Array), {
      anchor: reusedDestination.pubkey,
      reserveIndexes: [],
      reuseIndexes: [0],
    })
  })

  it('spares the on-screen receive address when a gap-bound reuse has an alternative', async () => {
    const { wallet, fixture, planned } = gapAllocationFixture('68')
    fixture.destinationRawKeyring.receiveIssuedIndexes.push(
      ...Array.from({ length: 20 }, (_, index) => index)
    )
    // Index 0 is the receive address currently presented on screen — the most
    // likely one a counterparty is about to pay — so the fallback funds the
    // next-oldest handed-out index instead.
    fixture.destinationRawKeyring.getQbitReceiveState.mockImplementation(() => ({
      currentIndex: 0,
      issuedIndexes: [...fixture.destinationRawKeyring.receiveIssuedIndexes],
      usedIndexes: [],
    }))

    await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(planned()).toHaveLength(1)
    expect(planned()[0]).toMatchObject({ sourceIndex: 0, destinationIndex: 1 })
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(expect.any(String), 'regtest', expect.any(Array), {
      anchor: expect.any(String),
      reserveIndexes: [],
      reuseIndexes: [1],
    })
  })

  it('never pays a destination index that already carries on-chain activity', async () => {
    const { wallet, fixture, planned } = gapAllocationFixture('69')
    // Index 0 saw a deposit without ever being issued (another copy of the
    // seed used it); paying it again would reuse an active address.
    fixture.destinationRawKeyring.getQbitReceiveState.mockImplementation(() => ({
      currentIndex: null,
      issuedIndexes: [],
      usedIndexes: [0],
    }))

    await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(planned()).toHaveLength(1)
    expect(planned()[0]).toMatchObject({ sourceIndex: 0, destinationIndex: 1 })
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(expect.any(String), 'regtest', expect.any(Array), {
      anchor: expect.any(String),
      reserveIndexes: [1],
      reuseIndexes: [],
    })
  })

  it('rejects signing a plan whose destination does not match the destination derivation', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // The persisted plan claims destination index 1 but carries the anchor's
    // address: derivation is the source of truth, so preparation must refuse
    // to bind it for signing.
    const tamperedPlan = {
      ...fixture.vaultState.migration.plans[0],
      status: 'prepared' as const,
      signedPsbtHex: undefined,
      txid: undefined,
      sourceIndex: 1,
      destinationIndex: 1,
      destinationPubkey: fixture.destinationAccount.pubkey,
      destinationAddress: fixture.destinationAccount.address,
    }
    const vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [tamperedPlan] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      network: 'regtest' as const,
      state: vaultState,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(
      async () => fixture.publicState(vaultState) as any
    )

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).rejects.toThrow(
      'destination does not match its derivation'
    )
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  })

  function installSecondNetworkRecoveryFixture() {
    const wallet = new WalletController()
    const sourceAccount = p2mrAccount('71'.repeat(32))
    const destinationAccount = p2mrAccount('72'.repeat(32))
    const sourceKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [sourceAccount],
    }
    const destinationKeyring = {
      index: 1,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [destinationAccount],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      sourceKeyring as any,
      destinationKeyring as any,
    ])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(sourceAccount as any)
    installQbitDestinationRawKeyring(destinationAccount, 1)
    // A prior testnet4 migration already archived into the destination; the
    // active regtest network is still seed-only restored.
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === sourceAccount.address
        ? ({
            version: 2 as const,
            acknowledgement: 'accepted' as const,
            networks: {
              testnet4: {
                status: 'migrated' as const,
                addressDiscoveryComplete: true,
                migration: {
                  destinationKeyringIndex: 1,
                  destinationPubkey: destinationAccount.pubkey,
                  destinationAddress: destinationAccount.p2mr.addresses.testnet4,
                  network: 'testnet4' as const,
                  plans: [],
                },
              },
              regtest: { status: 'seed-only-restored' as const, addressDiscoveryComplete: false },
              mainnet: { status: 'seed-only-restored' as const, addressDiscoveryComplete: false },
            },
          } as any)
        : undefined
    )
    vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
      status: 'migrating',
      acknowledgement: 'accepted',
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures: 0,
    } as any)
    vi.mocked(keyringService.beginQbitRecoveryMigrationToExistingDestination).mockResolvedValue({
      destinationKeyringIndex: 1,
      destinationPubkey: destinationAccount.pubkey,
      destinationAddress: destinationAccount.address,
    } as any)
    return { wallet, sourceAccount, destinationAccount }
  }

  it('routes a second-network migration to the destination the first migration created', async () => {
    const { wallet, sourceAccount, destinationAccount } = installSecondNetworkRecoveryFixture()

    await wallet.beginQbitRecoveryMigrationToExistingDestination({ sourceKeyringIndex: 0 })

    expect(keyringService.beginQbitRecoveryMigrationToExistingDestination).toHaveBeenCalledWith({
      sourceAddress: sourceAccount.address,
      network: 'regtest',
      destinationPubkey: destinationAccount.pubkey,
      destinationAddress: destinationAccount.address,
    })
    expect(keyringService.createQbitMigrationKeyring).not.toHaveBeenCalled()
  })

  it('honors the confirmed fresh seed even when another network recorded a destination', async () => {
    const { wallet, sourceAccount } = installSecondNetworkRecoveryFixture()

    // The user only reaches the create path after backing up and confirming
    // this mnemonic; silently rerouting to the recorded destination would
    // leave them trusting a seed that never received the migrated funds.
    await wallet.createQbitRecoveryMigrationWallet({
      sourceKeyringIndex: 0,
      mnemonic: 'confirmed fresh words',
      hdPath: '',
      passphrase: '',
    })

    expect(keyringService.createQbitMigrationKeyring).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAddress: sourceAccount.address,
        mnemonic: 'confirmed fresh words',
        network: 'regtest',
      })
    )
    expect(keyringService.beginQbitRecoveryMigrationToExistingDestination).not.toHaveBeenCalled()
  })

  it('resolves the migration source by anchor identity when compaction staled the route index', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // The migration screen captured index 2 at navigation; a queued removal
    // then compacted the source down to index 1.
    const compactedSource = { ...fixture.sourceKeyring, index: 1 }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([compactedSource as any])
    const load = vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring: compactedSource,
      anchor: fixture.sourceAccount,
      state: { ...fixture.vaultState, status: 'migrated' as const },
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    })
    vi.spyOn(wallet, 'getQbitRecoveryState').mockResolvedValue({
      ...fixture.publicState(fixture.vaultState),
      status: 'migrated',
    } as any)

    await wallet.prepareQbitRecoveryMigration(2, undefined, fixture.sourceAccount.pubkey)
    expect(load).toHaveBeenCalledWith(1)

    // An anchor that no longer matches any wallet fails closed instead of
    // falling back to whichever keyring holds the captured slot now.
    await expect(
      wallet.prepareQbitRecoveryMigration(2, undefined, '77'.repeat(32))
    ).rejects.toThrow('Qbit recovery keyring is unavailable')
  })

  it('does not archive an incomplete discovery when preparation finds no known funds', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const state = {
      ...fixture.vaultState,
      addressDiscoveryComplete: false,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    })
    getAddressUtxosMock.mockResolvedValue([])

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).rejects.toThrow(
      'Qbit recovery address discovery is incomplete'
    )

    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('does not archive an incomplete discovery after its known plans confirm', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const confirmedPlan = {
      ...fixture.vaultState.migration.plans[0],
      status: 'confirmed' as const,
    }
    const state = {
      ...fixture.vaultState,
      addressDiscoveryComplete: false,
      migration: { ...fixture.vaultState.migration, plans: [confirmedPlan] },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    })
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockResolvedValue(fixture.sourceKeyring)
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockResolvedValue(wrapRegtestVaultState(state))
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    getAddressUtxosMock.mockResolvedValue([])

    await expect(wallet.advanceQbitRecoveryMigration(2)).rejects.toThrow(
      'Qbit recovery address discovery is incomplete'
    )

    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('completes a truncated discovery during advancement when the rescan ends clean', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      addressDiscoveryComplete: false,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.completeQbitRecoveryAddressDiscovery).mockImplementation(async () => {
      vaultState = { ...vaultState, addressDiscoveryComplete: true }
      return currentPublicState()
    })
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    const scanAddress = (index: number) => `qbrt1zrescan${index}`
    ;(keyringService as any).keyrings[2] = {
      getAccounts: async () => [fixture.sourceAccount.pubkey],
      getQbitReceiveAccount: async (index: number) => ({
        addresses: { regtest: index === 0 ? fixture.sourceAccount.address : scanAddress(index) },
      }),
    }
    getAddressUtxosMock.mockResolvedValue([])
    const inactiveStats = (address: string) => ({
      address,
      chain_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    getAddressStatsMock.mockImplementation(async (address: string) =>
      address === fixture.sourceAccount.address
        ? quietAddressStats(address)
        : inactiveStats(address)
    )

    try {
      await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
        status: 'migrated',
      })
    } finally {
      delete (keyringService as any).keyrings[2]
    }

    expect(keyringService.recordQbitReceiveActivity).toHaveBeenCalledWith(
      fixture.sourceAccount.pubkey,
      'regtest',
      [0]
    )
    expect(keyringService.completeQbitRecoveryAddressDiscovery).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest'
    )
    expect(keyringService.addNewAccount).not.toHaveBeenCalled()
    expect(keyringService.rearmQbitRestoreFloorsForKeyring).not.toHaveBeenCalled()
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      { allowIncompletePlanRecord: true }
    )
  })

  it('activates newly discovered accounts instead of archiving a truncated source', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      addressDiscoveryComplete: false,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.completeQbitRecoveryAddressDiscovery).mockImplementation(async () => {
      vaultState = { ...vaultState, addressDiscoveryComplete: true }
      return currentPublicState()
    })
    const scanAddress = (index: number) => `qbrt1zrescan${index}`
    const rawPubkeys = [fixture.sourceAccount.pubkey]
    const rawKeyring = {
      type: KeyringType.QbitHdKeyring,
      pqcFloorsPending: false,
      getAccounts: async () => [...rawPubkeys],
      getQbitReceiveAccount: async (index: number) => ({
        addresses: { regtest: index === 0 ? fixture.sourceAccount.address : scanAddress(index) },
      }),
    }
    ;(keyringService as any).keyrings[2] = rawKeyring
    vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mockImplementation(async () => {
      rawKeyring.pqcFloorsPending = true
      return true
    })
    vi.mocked(keyringService.restorePqcSignatureCounterFloors).mockImplementation(async () => {
      rawKeyring.pqcFloorsPending = false
      return {
        floors: [{ observedCounter: 3, counterProvenance: 'restored-floor' }],
        gapIndexesWithActivity: [],
        possibleConcurrentInstance: false,
      } as any
    })
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      rawPubkeys.push(`pubkey-${rawPubkeys.length}`)
      return [rawPubkeys[rawPubkeys.length - 1]!]
    })
    getAddressUtxosMock.mockResolvedValue([])
    const inactiveStats = (address: string) => ({
      address,
      chain_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    // Index 1 was beyond the original truncated scan and turns out active.
    getAddressStatsMock.mockImplementation(async (address: string) =>
      address === fixture.sourceAccount.address || address === scanAddress(1)
        ? quietAddressStats(address)
        : inactiveStats(address)
    )

    try {
      await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
        status: 'migrating',
      })
    } finally {
      delete (keyringService as any).keyrings[2]
    }

    expect(keyringService.addNewAccount).toHaveBeenCalledTimes(1)
    expect(keyringService.recordQbitReceiveActivity).toHaveBeenCalledWith(
      fixture.sourceAccount.pubkey,
      'regtest',
      [0, 1]
    )
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
    // The source must be sign-locked before the new zero-floor account exists,
    // and its floors reconstructed afterward so a sweep cannot sign from zero.
    expect(keyringService.rearmQbitRestoreFloorsForKeyring).toHaveBeenCalledWith(
      fixture.sourceAccount.address
    )
    expect(keyringService.restorePqcSignatureCounterFloors).toHaveBeenCalledWith(
      fixture.sourceAccount.pubkey,
      expect.any(Function),
      undefined
    )
    const rearmOrder =
      vi.mocked(keyringService.rearmQbitRestoreFloorsForKeyring).mock.invocationCallOrder[0]!
    const addAccountOrder = vi.mocked(keyringService.addNewAccount).mock.invocationCallOrder[0]!
    const scanOrder =
      vi.mocked(keyringService.restorePqcSignatureCounterFloors).mock.invocationCallOrder[0]!
    expect(rearmOrder).toBeLessThan(addAccountOrder)
    expect(addAccountOrder).toBeLessThan(scanOrder)
    expect(rawKeyring.pqcFloorsPending).toBe(false)
  })

  it('persists, binds, signs, resumes, and archives a fresh-wallet recovery migration', async () => {
    const wallet = new WalletController()
    const sourceAccount = {
      ...p2mrAccount('31'.repeat(32)),
      p2mr: {
        ...p2mrAccount('31'.repeat(32)).p2mr,
        signatureCounter: {
          count: 4,
          limit: 1073741824,
          remaining: 1073741820,
          state: 'normal',
          provenance: 'restored-floor',
          knownOnChainSignatures: 4,
        },
      },
    }
    const destinationAccount = p2mrAccount('32'.repeat(32))
    const sourceKeyring = {
      index: 2,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [sourceAccount],
    }
    const destinationKeyring = {
      index: 3,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [destinationAccount],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      sourceKeyring as any,
      destinationKeyring as any,
    ])
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(sourceAccount as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    installQbitDestinationRawKeyring(destinationAccount)

    let vaultState: any = {
      version: 1,
      status: 'migrating',
      acknowledgement: 'accepted',
      addressDiscoveryComplete: true,
      migration: {
        destinationKeyringIndex: 3,
        destinationPubkey: destinationAccount.pubkey,
        destinationAddress: destinationAccount.address,
        network: 'regtest',
        plans: [],
      },
    }
    const publicState = () => ({
      status: vaultState.status,
      acknowledgement: vaultState.acknowledgement,
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures: 4,
      migration: {
        destinationKeyringIndex: 3,
        destinationAddress: destinationAccount.address,
        network: 'regtest',
        plans: vaultState.migration.plans.map((plan: any) => ({
          id: plan.id,
          sourceAddress: plan.sourceAddress,
          destinationAddress: plan.destinationAddress,
          amount: plan.amount,
          fee: plan.fee,
          status: plan.status,
          ...(plan.txid ? { txid: plan.txid } : {}),
        })),
      },
    })
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === sourceAccount.address ? wrapRegtestVaultState(vaultState) : undefined
    )
    vi.mocked(keyringService.getQbitRecoveryState).mockImplementation(async address =>
      address === sourceAccount.address
        ? publicState()
        : {
            status: 'clean',
            acknowledgement: 'accepted',
            counterConfidence: 'local',
            knownOnChainSignatures: 0,
          }
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = {
          ...vaultState,
          migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
        }
        return publicState()
      }
    )
    vi.mocked(keyringService.updateQbitRecoveryMigrationPlan).mockImplementation(
      async (_address, _network, planId, update) => {
        vaultState = {
          ...vaultState,
          migration: {
            ...vaultState.migration,
            plans: vaultState.migration.plans.map((plan: any) =>
              plan.id === planId ? { ...plan, ...update } : plan
            ),
          },
        }
        return publicState()
      }
    )
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated', acknowledgement: 'accepted' }
      return publicState()
    })

    const fundingTxid = '51'.repeat(32)
    const availableTxid = '53'.repeat(32)
    const dustTxid = '52'.repeat(32)
    const fundingUtxo = {
      txid: fundingTxid,
      vout: 0,
      value: 50_000,
      status: { confirmed: true, block_height: 10 },
    }
    const availableUtxo = {
      txid: availableTxid,
      vout: 0,
      value: 50_000,
      status: { confirmed: true, block_height: 10 },
    }
    const dustUtxo = {
      txid: dustTxid,
      vout: 0,
      value: 100,
      status: { confirmed: true, block_height: 11 },
    }
    let releaseUtxoDiscovery!: () => void
    const utxoDiscoveryGate = new Promise<void>(resolve => {
      releaseUtxoDiscovery = resolve
    })
    let reportUtxoDiscoveryStarted!: () => void
    const utxoDiscoveryStarted = new Promise<void>(resolve => {
      reportUtxoDiscoveryStarted = resolve
    })
    getAddressUtxosMock.mockImplementationOnce(async () => {
      reportUtxoDiscoveryStarted()
      await utxoDiscoveryGate
      return [fundingUtxo, availableUtxo, dustUtxo]
    })
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockResolvedValue(
      new Set([`${fundingTxid}:0`])
    )
    getTxMock.mockImplementation(async txid => {
      const isDust = txid === dustTxid
      return {
        txid,
        vin: [{ is_coinbase: false }],
        vout: [
          {
            value: isDust ? 100 : 50_000,
            scriptpubkey: sourceAccount.p2mr.scriptPubKey,
          },
        ],
      }
    })
    const migrationBudget = {
      ...SIGNATURE_BUDGET,
      restoredFloorRisk: {
        recoveryStatus: 'seed-only-restored' as const,
        counterConfidence: 'chain-floor-only' as const,
        knownOnChainSignatures: 4,
        challengeId: 'migration-challenge',
      },
    }
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockResolvedValue(migrationBudget)
    const selectionSpy = vi.spyOn(wallet as any, 'selectQbitRecoverySweepBatches')

    const performSetChainType = vi
      .spyOn(wallet as any, 'performSetChainType')
      .mockResolvedValue(undefined)
    const preparation = wallet.prepareQbitRecoveryMigration(2)
    await utxoDiscoveryStarted
    const networkChange = wallet.setChainType(ChainType.QBIT_TESTNET4)
    await Promise.resolve()
    expect(performSetChainType).not.toHaveBeenCalled()

    releaseUtxoDiscovery()
    const prepared = await preparation
    await networkChange

    expect(prepared.toSignDatas).toHaveLength(1)
    expect(prepared.toSignDatas[0]).toMatchObject({
      estimatedFee: expect.any(Number),
      signatureBudget: migrationBudget,
      qbitRecoveryMigration: {
        sourceKeyringIndex: 2,
        destinationKeyringIndex: 3,
        network: 'regtest',
        destinationAddress: destinationAccount.address,
      },
    })
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(
      sourceAccount.address,
      'regtest',
      [expect.objectContaining({ status: 'prepared', psbtHex: expect.any(String) })],
      expect.objectContaining({ reserveIndexes: [0] })
    )
    expect(
      vi.mocked(keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations).mock
        .invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(keyringService.preflightP2mrPsbtSigning).mock.invocationCallOrder[0]!)
    expect(
      vi.mocked(keyringService.preflightP2mrPsbtSigning).mock.invocationCallOrder[0]
    ).toBeLessThan(performSetChainType.mock.invocationCallOrder[0]!)

    const originalToSignData = prepared.toSignDatas[0]!
    const preparedSummary = decodePsbt(parsePsbt(hexToBytes(originalToSignData.psbtHex)))
    expect(preparedSummary.inputs).toHaveLength(1)
    expect(preparedSummary.inputs[0]?.prevout.txid).toEqual(hexToBytes(reverseTxid(availableTxid)))
    expect(selectionSpy.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ txid: availableTxid }),
      expect.objectContaining({ txid: dustTxid }),
    ])
    // The UI leaves the rate unset, so preparation resolves the live normal
    // estimate (mocked at 3) instead of pricing the one-shot sweep at the
    // relay floor.
    expect(selectionSpy.mock.calls[0]?.[3]).toBe(3)
    expect(getFeeTiersMock).toHaveBeenCalled()
    await expect(
      wallet.signPsbtV2({
        ...originalToSignData,
        qbitRecoveryMigration: {
          ...originalToSignData.qbitRecoveryMigration!,
          destinationAddress: sourceAccount.address,
        },
      })
    ).rejects.toThrow('changed after review')
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()

    const reviewedAmount = vaultState.migration.plans[0].amount
    vaultState.migration.plans[0].amount += 1
    await expect(wallet.signPsbtV2(originalToSignData)).rejects.toThrow(
      'does not match the reviewed intent'
    )
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    vaultState.migration.plans[0].amount = reviewedAmount

    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(
      async (_address, input) => {
        const signed = signP2mrPsbt({
          psbt: input.psbt,
          keys: input.keys,
          sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
        })
        return {
          psbt: signed.psbt,
          signed: signed.signed,
          counterResults: [],
        }
      }
    )
    await wallet.signPsbtV2(originalToSignData)

    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledWith(
      sourceAccount.address,
      expect.objectContaining({ psbt: expect.any(Object), keys: expect.any(Array) }),
      migrationBudget,
      false
    )
    expect(keyringService.updateQbitRecoveryMigrationPlan).toHaveBeenCalledWith(
      sourceAccount.address,
      'regtest',
      vaultState.migration.plans[0].id,
      expect.objectContaining({
        status: 'signed',
        signedPsbtHex: expect.any(String),
        txid: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    )
    const migrationTxid = vaultState.migration.plans[0].txid
    let releaseLifecycleCheck!: () => void
    const lifecycleCheckGate = new Promise<void>(resolve => {
      releaseLifecycleCheck = resolve
    })
    let reportLifecycleCheckStarted!: () => void
    const lifecycleCheckStarted = new Promise<void>(resolve => {
      reportLifecycleCheckStarted = resolve
    })
    const lifecycle = vi
      .spyOn(wallet, 'getQbitTxLifecycleStatus')
      .mockImplementationOnce(async () => {
        reportLifecycleCheckStarted()
        await lifecycleCheckGate
        return { state: 'gone' }
      })
      .mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValueOnce({ state: 'confirmed' })
    const pushTx = vi.spyOn(wallet, 'pushTx').mockResolvedValue(migrationTxid)

    const advancement = wallet.advanceQbitRecoveryMigration(2)
    await lifecycleCheckStarted
    const advancementNetworkChange = wallet.setChainType(ChainType.QBIT_TESTNET4)
    await Promise.resolve()
    expect(performSetChainType).toHaveBeenCalledTimes(1)
    releaseLifecycleCheck()

    await expect(advancement).resolves.toMatchObject({
      status: 'migrating',
      migration: { plans: [expect.objectContaining({ status: 'broadcast' })] },
    })
    await advancementNetworkChange
    expect(pushTx.mock.invocationCallOrder[0]).toBeLessThan(
      performSetChainType.mock.invocationCallOrder[1]!
    )
    expect(pushTx).toHaveBeenCalledWith(vaultState.migration.plans[0].signedPsbtHex)

    getAddressUtxosMock.mockResolvedValueOnce([dustUtxo])
    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrated',
      migration: { plans: [expect.objectContaining({ status: 'confirmed' })] },
    })
    expect(lifecycle).toHaveBeenCalledTimes(3)
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(sourceAccount.address, 'regtest', {
      allowIncompletePlanRecord: true,
    })
    expect(changeKeyring).toHaveBeenCalledWith(destinationKeyring, 0)

    changeKeyring.mockClear()
    lifecycle.mockResolvedValue({ state: 'confirmed' })
    getAddressUtxosMock.mockResolvedValueOnce([dustUtxo])
    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrated',
    })
    expect(changeKeyring).toHaveBeenCalledWith(destinationKeyring, 0)

    await expect(wallet.removeKeyring(sourceKeyring as any)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      message: 'qbit_recovery_wallets_retained',
      data: { reasons: [{ role: 'source', network: 'regtest', status: 'migrated' }] },
    })
    await expect(wallet.removeKeyring(destinationKeyring as any)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: [{ role: 'destination', network: 'regtest', status: 'migrated' }] },
    })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()

    // Confirmed risks lift what used to be a permanent block: the
    // acknowledged removal re-runs the check and proceeds while the fresh
    // risks stay within the confirmed reason set.
    await expect(
      wallet.removeKeyring(destinationKeyring as any, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: [
          { role: 'destination', network: 'regtest', status: 'migrated' },
        ],
      })
    ).resolves.toBe(destinationKeyring)
    expect(keyringService.removeKeyring).toHaveBeenCalledWith(3)
  })

  it.each(['migrating', 'migrated'] as const)(
    'asks for risk confirmation on migration keyrings after a coin-type switch while the raw lifecycle is %s',
    async status => {
      const wallet = new WalletController()
      const fixture = qbitRecoveryMigrationFixture()
      const vaultState = { ...fixture.vaultState, status }
      vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
        fixture.sourceKeyring as any,
        fixture.destinationKeyring as any,
      ])
      vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
      vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
        address === fixture.sourceAccount.address ? wrapRegtestVaultState(vaultState) : undefined
      )
      vi.mocked(keyringService.getQbitRecoveryState).mockResolvedValue({
        status: 'seed-only-restored',
        acknowledgement: 'accepted',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 4,
      })

      // The fixture plan is broadcast but unconfirmed, so both wallets carry
      // the in-flight warning alongside their role.
      await expect(wallet.removeKeyring(fixture.sourceKeyring as any)).rejects.toMatchObject({
        code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
        data: {
          reasons: [{ role: 'source', network: 'regtest', status, hasInflightPlans: true }],
        },
      })
      await expect(wallet.removeKeyring(fixture.destinationKeyring as any)).rejects.toMatchObject({
        code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
        data: {
          reasons: [{ role: 'destination', network: 'regtest', status, hasInflightPlans: true }],
        },
      })
      expect(keyringService.getQbitRecoveryVaultState).toHaveBeenCalledWith(
        fixture.sourceAccount.address
      )
      expect(keyringService.getQbitRecoveryState).not.toHaveBeenCalled()
      expect(keyringService.removeKeyring).not.toHaveBeenCalled()

      // Either wallet stays removable once the user confirms the risks.
      await wallet.removeKeyring(fixture.sourceKeyring as any, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: [
          { role: 'source', network: 'regtest', status, hasInflightPlans: true },
        ],
      })
      expect(keyringService.removeKeyring).toHaveBeenCalledWith(fixture.sourceKeyring.index)
      await wallet.removeKeyring(fixture.destinationKeyring as any, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: [
          { role: 'destination', network: 'regtest', status, hasInflightPlans: true },
        ],
      })
      expect(keyringService.removeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring.index)
    }
  )

  it('re-prompts a confirmed removal when new recovery risks appeared while the warning was open', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // The displayed warning predates the in-flight sweep: the plan was still
    // prepared when the user read and confirmed the risks.
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'prepared' as const }],
      },
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      fixture.sourceKeyring as any,
      fixture.destinationKeyring as any,
    ])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === fixture.sourceAccount.address ? wrapRegtestVaultState(vaultState) : undefined
    )

    const displayedReasons = [{ role: 'source' as const, network: 'regtest', status: 'migrating' }]
    await expect(wallet.removeKeyring(fixture.sourceKeyring as any)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: displayedReasons },
    })

    // Another window signs and broadcasts the sweep while the popover is
    // open; the acknowledged retry must surface the new in-flight risk
    // instead of deleting the source over it.
    vaultState = fixture.vaultState
    await expect(
      wallet.removeKeyring(fixture.sourceKeyring as any, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: displayedReasons as any,
      })
    ).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: {
        reasons: [
          { role: 'source', network: 'regtest', status: 'migrating', hasInflightPlans: true },
        ],
      },
    })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()

    // Confirming the refreshed warning proceeds.
    await wallet.removeKeyring(fixture.sourceKeyring as any, {
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: [
        { role: 'source', network: 'regtest', status: 'migrating', hasInflightPlans: true },
      ] as any,
    })
    expect(keyringService.removeKeyring).toHaveBeenCalledWith(fixture.sourceKeyring.index)
  })

  it('retains the migration destination after keyring compaction stales the persisted index', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // An earlier removal below the destination compacted the keyring array:
    // the destination now sits at index 2 while the vault still records 3,
    // which an unrelated keyring occupies.
    const sourceKeyring = { ...fixture.sourceKeyring, index: 1 }
    const destinationKeyring = { ...fixture.destinationKeyring, index: 2 }
    const unrelatedKeyring = {
      index: 3,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('33'.repeat(32))],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      sourceKeyring as any,
      destinationKeyring as any,
      unrelatedKeyring as any,
    ])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === fixture.sourceAccount.address ? wrapRegtestVaultState(fixture.vaultState) : undefined
    )

    await expect(wallet.removeKeyring(destinationKeyring as any)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: [{ role: 'destination', network: 'regtest', status: 'migrating' }] },
    })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()

    await expect(wallet.removeKeyring(unrelatedKeyring as any)).resolves.toBe(unrelatedKeyring)
    expect(keyringService.removeKeyring).toHaveBeenCalledWith(3)
  })

  it('recognizes the retained destination recorded under another coin type', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // The migration was created on mainnet (coin type 0'). After switching to
    // regtest (coin type 1') every displayed account is re-derived under the
    // other path, so the recorded identity matches nothing on screen, and the
    // persisted index 2 points at an unrelated keyring after compaction.
    const storedDestination = p2mrAccount('55'.repeat(32))
    const vaultState = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        network: 'mainnet' as const,
        destinationKeyringIndex: 2,
        destinationPubkey: storedDestination.pubkey,
        destinationAddress: storedDestination.p2mr.addresses.mainnet,
      },
    }
    const sourceKeyring = { ...fixture.sourceKeyring, index: 0 }
    const destinationKeyring = { ...fixture.destinationKeyring, index: 1 }
    const unrelatedKeyring = {
      index: 2,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('33'.repeat(32))],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      sourceKeyring as any,
      destinationKeyring as any,
      unrelatedKeyring as any,
    ])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === fixture.sourceAccount.address ? wrapRegtestVaultState(vaultState) : undefined
    )
    const rawKeyring = (mnemonic: string) => ({
      type: KeyringType.QbitHdKeyring,
      mnemonic,
      passphrase: '',
      hdPath: "m/87'/1'/0'/0",
    })
    ;(keyringService as any).keyrings[0] = rawKeyring('source words')
    ;(keyringService as any).keyrings[1] = rawKeyring('destination words')
    ;(keyringService as any).keyrings[2] = rawKeyring('unrelated words')
    vi.mocked(keyringService.createTmpKeyring).mockImplementation(
      (_type, opts: any) =>
        ({
          getQbitAccounts: async () =>
            opts.mnemonic === 'destination words'
              ? [{ pubkey: storedDestination.pubkey, addresses: storedDestination.p2mr.addresses }]
              : [{ pubkey: '44'.repeat(32), addresses: {} }],
        }) as any
    )

    try {
      await expect(wallet.removeKeyring(destinationKeyring as any)).rejects.toMatchObject({
        code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
        data: { reasons: [{ role: 'destination', network: 'mainnet', status: 'migrating' }] },
      })
      expect(keyringService.removeKeyring).not.toHaveBeenCalled()
      expect(keyringService.createTmpKeyring).toHaveBeenCalledWith(
        KeyringType.QbitHdKeyring,
        expect.objectContaining({ hdPath: "m/87'/0'/0'/0", mnemonic: 'destination words' })
      )

      // The stale persisted index no longer misdirects the check once the
      // stored identity resolves to a live keyring.
      await expect(wallet.removeKeyring(unrelatedKeyring as any)).resolves.toBe(unrelatedKeyring)
      expect(keyringService.removeKeyring).toHaveBeenCalledWith(2)

      // A candidate that cannot be verified surfaces the uncertainty for
      // confirmation instead of failing the removal closed: the target may be
      // the real destination.
      vi.mocked(keyringService.createTmpKeyring).mockImplementation(() => {
        throw new Error('derivation unavailable')
      })
      await expect(wallet.removeKeyring(unrelatedKeyring as any)).rejects.toMatchObject({
        code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
        data: { reasons: [{ role: 'unverified', network: 'mainnet', status: 'migrating' }] },
      })

      // The acknowledged retry re-verifies, and the still-unverifiable
      // candidate stays within the confirmed reason set, so it cannot hard
      // block the removal.
      await expect(
        wallet.removeKeyring(unrelatedKeyring as any, {
          acknowledgedQbitRecoveryRisks: true,
          acknowledgedQbitRecoveryReasons: [
            { role: 'unverified', network: 'mainnet', status: 'migrating', hasInflightPlans: true },
          ],
        })
      ).resolves.toBe(unrelatedKeyring)
      expect(keyringService.removeKeyring).toHaveBeenLastCalledWith(2)
    } finally {
      delete (keyringService as any).keyrings[0]
      delete (keyringService as any).keyrings[1]
      delete (keyringService as any).keyrings[2]
    }
  })

  it('re-resolves a queued removal whose captured index was staled by compaction', async () => {
    const wallet = new WalletController()
    // The user asked to remove this wallet while it sat at index 2; an earlier
    // queued removal then compacted the keyring array, moving it to index 1
    // and moving an unrelated wallet into the captured slot.
    const capturedTarget = {
      index: 2,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('44'.repeat(32))],
    }
    const compactedTarget = { ...capturedTarget, index: 1 }
    const survivor = {
      index: 2,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('55'.repeat(32))],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([compactedTarget as any, survivor as any])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockResolvedValue(undefined)

    await wallet.removeKeyring(capturedTarget as any)
    expect(keyringService.removeKeyring).toHaveBeenCalledWith(1)
  })

  it('rejects a queued removal whose wallet was already removed', async () => {
    const wallet = new WalletController()
    const captured = {
      index: 1,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('44'.repeat(32))],
    }
    const survivor = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [p2mrAccount('55'.repeat(32))],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([survivor as any])
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockResolvedValue(undefined)

    await expect(wallet.removeKeyring(captured as any)).rejects.toThrow('no longer available')
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()
  })

  it('queues keyring removal so it cannot interleave with a migration start', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([
      fixture.sourceKeyring as any,
      fixture.destinationKeyring as any,
    ])
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // The removal was requested while the source still looked seed-only
    // restored, but a migration start is already in the chain-state queue:
    // the retained-wallet guard must observe the state that start persists,
    // not the stale pre-queue view.
    let vaultState: any
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async address =>
      address === fixture.sourceAccount.address ? wrapRegtestVaultState(vaultState) : undefined
    )
    let releaseMigrationStart!: () => void
    const migrationStartGate = new Promise<void>(resolve => (releaseMigrationStart = resolve))
    const migrationStart = (wallet as any).enqueueChainStateChange(async () => {
      await migrationStartGate
      vaultState = fixture.vaultState
    })

    const removal = wallet.removeKeyring(fixture.sourceKeyring as any)
    await Promise.resolve()
    await Promise.resolve()
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()

    releaseMigrationStart()
    await migrationStart
    await expect(removal).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: [{ role: 'source', network: 'regtest', status: 'migrating' }] },
    })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()
  })

  it('removes a conflicted recovery migration plan so its replacement UTXO can be prepared', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const retainedPlan = {
      ...fixture.vaultState.migration.plans[0],
      id: `${fixture.sourceAccount.pubkey}:1`,
      status: 'confirmed' as const,
      txid: '64'.repeat(32),
    }
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [fixture.vaultState.migration.plans[0], retainedPlan],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    // The conflicted-plan removal persists through the plain replacement while
    // the follow-up preparation persists plans and reservations together.
    const applyPlanReplacement = async (_address: string, _network: string, plans: any[]) => {
      vaultState = {
        ...vaultState,
        migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
      }
      return currentPublicState()
    }
    vi.mocked(keyringService.replaceQbitRecoveryMigrationPlans).mockImplementation(
      applyPlanReplacement
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(applyPlanReplacement)
    const replacementTxid = '63'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: replacementTxid,
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 11 },
      },
    ])
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 50_000, scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey }],
    }))
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === retainedPlan.txid ? { state: 'confirmed' } : { state: 'gone' }
    )
    const conflictingTxid = '66'.repeat(32)
    getAddressStatsMock.mockResolvedValue({
      address: fixture.sourceAccount.address,
      chain_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 50_000,
        spent_txo_count: 1,
        spent_txo_sum: 50_000,
        tx_count: 1,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    getAddressHistoryMock.mockResolvedValue({
      confirmed: [
        {
          txid: conflictingTxid,
          vin: [
            {
              txid: fixture.sourceTxid,
              vout: 0,
              prevout: { scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey },
              is_coinbase: false,
            },
          ],
          status: { confirmed: true, block_height: 12 },
        },
      ],
      mempool: [],
    })
    const rebroadcastError = new Error('migration input already spent')
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(rebroadcastError)

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: { plans: [{ id: retainedPlan.id, status: 'confirmed' }] },
    })
    expect(keyringService.replaceQbitRecoveryMigrationPlans).toHaveBeenNthCalledWith(
      1,
      fixture.sourceAccount.address,
      'regtest',
      [retainedPlan]
    )

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(prepared.toSignDatas).toHaveLength(1)
    const preparedSummary = decodePsbt(parsePsbt(hexToBytes(prepared.toSignDatas[0]!.psbtHex)))
    expect(preparedSummary.inputs[0]?.prevout.txid).toEqual(
      hexToBytes(reverseTxid(replacementTxid))
    )
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenLastCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      [
        retainedPlan,
        expect.objectContaining({
          id: `${fixture.sourceAccount.pubkey}:2`,
          status: 'prepared',
        }),
      ],
      // The re-sweep pays the index its earlier plan paired; the version-1
      // ledger never tracked that pairing, so the index is reserved now.
      expect.objectContaining({ reserveIndexes: [0], reuseIndexes: [] })
    )
    expect(new Set(vaultState.migration.plans.map((plan: any) => plan.id)).size).toBe(2)
  })

  it('reopens a confirmed migration plan when its transaction loses confirmation', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const reorgedPlan = {
      ...fixture.vaultState.migration.plans[0],
      id: `${fixture.sourceAccount.pubkey}:1`,
      status: 'confirmed' as const,
      txid: '64'.repeat(32),
    }
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [reorgedPlan, fixture.vaultState.migration.plans[0]],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(keyringService.updateQbitRecoveryMigrationPlan).mockImplementation(
      async (_address, _network, planId, update) => {
        vaultState = {
          ...vaultState,
          migration: {
            ...vaultState.migration,
            plans: vaultState.migration.plans.map((plan: any) =>
              plan.id === planId ? { ...plan, ...update } : plan
            ),
          },
        }
        return currentPublicState()
      }
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === reorgedPlan.txid ? { state: 'pending' } : { state: 'confirmed' }
    )

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: {
        plans: [
          { id: reorgedPlan.id, status: 'broadcast' },
          { id: fixture.vaultState.migration.plans[0].id, status: 'confirmed' },
        ],
      },
    })

    expect(keyringService.updateQbitRecoveryMigrationPlan).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      reorgedPlan.id,
      {
        status: 'broadcast',
        signedPsbtHex: reorgedPlan.signedPsbtHex,
        txid: reorgedPlan.txid,
      }
    )
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
    expect(getAddressUtxosMock).not.toHaveBeenCalled()
  })

  it('rebroadcasts a reorged confirmed plan in the same advance pass when its transaction is gone', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const reorgedPlan = {
      ...fixture.vaultState.migration.plans[0],
      id: `${fixture.sourceAccount.pubkey}:1`,
      status: 'confirmed' as const,
      txid: '64'.repeat(32),
    }
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [reorgedPlan, fixture.vaultState.migration.plans[0]],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(keyringService.updateQbitRecoveryMigrationPlan).mockImplementation(
      async (_address, _network, planId, update) => {
        vaultState = {
          ...vaultState,
          migration: {
            ...vaultState.migration,
            plans: vaultState.migration.plans.map((plan: any) =>
              plan.id === planId ? { ...plan, ...update } : plan
            ),
          },
        }
        return currentPublicState()
      }
    )
    let rebroadcast = false
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid => {
      if (txid !== reorgedPlan.txid) return { state: 'confirmed' }
      return rebroadcast ? { state: 'pending' } : { state: 'gone' }
    })
    const pushTx = vi.spyOn(wallet, 'pushTx').mockImplementation(async () => {
      rebroadcast = true
      return reorgedPlan.txid
    })

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: {
        plans: [
          { id: reorgedPlan.id, status: 'broadcast' },
          { id: fixture.vaultState.migration.plans[0].id, status: 'confirmed' },
        ],
      },
    })

    expect(pushTx).toHaveBeenCalledTimes(1)
    expect(pushTx).toHaveBeenCalledWith(reorgedPlan.signedPsbtHex)
    expect(keyringService.updateQbitRecoveryMigrationPlan).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      reorgedPlan.id,
      {
        status: 'broadcast',
        signedPsbtHex: reorgedPlan.signedPsbtHex,
        txid: reorgedPlan.txid,
      }
    )
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('keeps a confirmed recovery migration active when the final scan finds a protected dust UTXO', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [
          {
            ...fixture.vaultState.migration.plans[0],
            status: 'confirmed',
          },
        ],
      },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    })
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockResolvedValue(fixture.sourceKeyring)
    vi.spyOn(wallet, 'getQbitRecoveryState').mockResolvedValue(fixture.publicState(vaultState))
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockResolvedValue(
        wrapRegtestVaultState(vaultState)
      )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    const protectedDustTxid = '65'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: protectedDustTxid,
        vout: 0,
        value: 100,
        status: { confirmed: true, block_height: 12 },
      },
    ])
    getTxMock.mockResolvedValue({
      txid: protectedDustTxid,
      vin: [{ is_coinbase: false }],
      vout: [{ value: 100, scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey }],
    })
    const assetCoverage = vi
      .spyOn(wallet as any, 'getQbitProtectedAssetCoverage')
      .mockResolvedValue({
        assetCount: 1,
        protectedOutpoints: new Set([`${protectedDustTxid}:0`]),
      })

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: { plans: [{ status: 'confirmed' }] },
    })

    expect(assetCoverage).toHaveBeenCalledWith([
      expect.objectContaining({ txid: protectedDustTxid, vout: 0 }),
    ])
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('waits for an unconfirmed source spender before archiving a confirmed migration', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // A reviewed protected-asset move rides outside the plan list; while it
    // sits in the mempool it hides the UTXOs it spends from the final scan.
    getAddressUtxosMock.mockResolvedValue([])
    getAddressStatsMock.mockImplementation(async address => quietAddressStats(address, 1))

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    getAddressStatsMock.mockImplementation(async address => quietAddressStats(address))
    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrated',
    })
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      { allowIncompletePlanRecord: true }
    )
    expect(changeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring, 0)
  })

  it('activates the destination account a 1:1 sweep actually funded after archiving', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Only source account 1 held funds, so its sweep paid destination
    // account 1; the index-0 anchor never received anything.
    const fundedDestination = p2mrAccount('23'.repeat(32))
    fixture.destinationKeyring.accounts.push(fundedDestination as any)
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [
          {
            ...fixture.vaultState.migration.plans[0],
            status: 'confirmed',
            sourceIndex: 1,
            destinationIndex: 1,
            destinationAddress: fundedDestination.address,
          },
        ],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    getAddressUtxosMock.mockResolvedValue([])

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrated',
    })
    expect(changeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring, 1)
  })

  it('waits for an untracked protected-asset spender before archiving a plan-less source', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // Protected-only source: its provider transfer never became a migration
    // plan, so the plan list is empty and the UTXO scan is vacuously clean
    // while that transfer is unconfirmed.
    getAddressUtxosMock.mockResolvedValue([])
    getAddressStatsMock.mockImplementation(async address => quietAddressStats(address, 1))

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).resolves.toMatchObject({
      state: { status: 'migrating' },
      toSignDatas: [],
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    getAddressStatsMock.mockImplementation(async address => quietAddressStats(address))
    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).resolves.toMatchObject({
      state: { status: 'migrated' },
      toSignDatas: [],
    })
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      { allowIncompletePlanRecord: true }
    )
    expect(changeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring, 0)
  })

  it('defers archiving a plan-less source while a coinbase reward is immature', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // A mined reward below qbit's 1,000-block coinbase maturity cannot enter a
    // sweep plan, so the spendable scan is vacuously clean while the source
    // still holds funds.
    const coinbaseTxid = '77'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: coinbaseTxid,
        vout: 0,
        value: 5_000_000_000,
        status: { confirmed: true, block_height: 1200 },
      },
    ])
    getTxMock.mockResolvedValue({
      txid: coinbaseTxid,
      vin: [{ is_coinbase: true }],
      vout: [{ scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey, value: 5_000_000_000 }],
    })
    getTipHeightMock.mockResolvedValue(1699)

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).resolves.toMatchObject({
      state: { status: 'migrating' },
      toSignDatas: [],
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    getAddressUtxosMock.mockResolvedValue([])
    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).resolves.toMatchObject({
      state: { status: 'migrated' },
      toSignDatas: [],
    })
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      { allowIncompletePlanRecord: true }
    )
    expect(changeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring, 0)
  })

  it('defers unconfirmed source funds instead of sweeping them into plans', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      migration: { ...fixture.vaultState.migration, plans: [] },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = { ...vaultState, migration: { ...vaultState.migration, plans } }
      }
    )
    // An unconfirmed parent could be evicted or replaced, which would strand
    // an immutable signed sweep spending it: the pending value must defer the
    // migration instead of entering a plan.
    const pendingTxid = '7a'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      { txid: pendingTxid, vout: 0, value: 5_000_000, status: { confirmed: false } },
    ])
    getTxMock.mockResolvedValue({
      txid: pendingTxid,
      vin: [{ is_coinbase: false }],
      vout: [{ scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey, value: 5_000_000 }],
    })

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).resolves.toMatchObject({
      state: { status: 'migrating' },
      toSignDatas: [],
    })
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).not.toHaveBeenCalled()
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    // Confirmation makes the same funds sweepable on the next preparation pass.
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: pendingTxid,
        vout: 0,
        value: 5_000_000,
        status: { confirmed: true, block_height: 1500 },
      },
    ])
    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)
    expect(prepared.toSignDatas).toHaveLength(1)
    expect(vaultState.migration.plans).toHaveLength(1)
    expect(vaultState.migration.plans[0]).toMatchObject({ status: 'prepared' })
  })

  it('waits for an immature coinbase reward before archiving a confirmed migration', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.markQbitRecoveryMigrated).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrated' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // The sweep confirmed, but a later mined reward is still maturing: the
    // final scan must treat it as remaining funds.
    const coinbaseTxid = '78'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: coinbaseTxid,
        vout: 0,
        value: 5_000_000_000,
        status: { confirmed: true, block_height: 1400 },
      },
    ])
    getTxMock.mockResolvedValue({
      txid: coinbaseTxid,
      vin: [{ is_coinbase: true }],
      vout: [{ scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey, value: 5_000_000_000 }],
    })
    getTipHeightMock.mockResolvedValue(1899)

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    getAddressUtxosMock.mockResolvedValue([])
    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrated',
    })
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      { allowIncompletePlanRecord: true }
    )
    expect(changeKeyring).toHaveBeenCalledWith(fixture.destinationKeyring, 0)
  })

  it('reopens a migrated source when an immature coinbase reward arrives', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = {
      ...fixture.vaultState,
      status: 'migrated',
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.reopenQbitRecoveryMigration).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrating' }
      return currentPublicState()
    })
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    // A reward mined to the archived source is invisible to the spendable
    // scan until maturity; the archive must still reopen for it instead of
    // presenting the source as fully migrated.
    const coinbaseTxid = '79'.repeat(32)
    getAddressUtxosMock.mockResolvedValue([
      {
        txid: coinbaseTxid,
        vout: 0,
        value: 5_000_000_000,
        status: { confirmed: true, block_height: 1500 },
      },
    ])
    getTxMock.mockResolvedValue({
      txid: coinbaseTxid,
      vin: [{ is_coinbase: true }],
      vout: [{ scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey, value: 5_000_000_000 }],
    })
    getTipHeightMock.mockResolvedValue(1999)

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
    })
    expect(keyringService.reopenQbitRecoveryMigration).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      []
    )
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
    expect(changeKeyring).not.toHaveBeenCalled()
  })

  it('keeps signed migration bytes when an empty UTXO response has no conflicting spend proof', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const vaultState = fixture.vaultState
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockResolvedValue({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    })
    getAddressUtxosMock.mockResolvedValue([])
    getAddressStatsMock.mockResolvedValue({
      address: fixture.sourceAccount.address,
      chain_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 50_000,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 1,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    getAddressHistoryMock.mockResolvedValue({
      confirmed: [
        {
          txid: fixture.sourceTxid,
          vin: [],
          status: { confirmed: true, block_height: 10 },
        },
      ],
      mempool: [],
    })
    // Only the sweep itself is gone; its funding parent is still confirmed,
    // so the empty UTXO response alone proves nothing.
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === fixture.vaultState.migration.plans[0].txid
        ? { state: 'gone' }
        : { state: 'confirmed' }
    )
    const rebroadcastError = new Error('temporary broadcast failure')
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(rebroadcastError)

    await expect(wallet.advanceQbitRecoveryMigration(2)).rejects.toBe(rebroadcastError)

    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).not.toHaveBeenCalled()
    expect(vaultState.migration.plans).toEqual([fixture.vaultState.migration.plans[0]])
    expect(getAddressUtxosMock).not.toHaveBeenCalled()
  })

  it('retires a plan whose confirmed funding parent disappeared without spender evidence', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    let vaultState: any = fixture.vaultState
    const currentPublicState = () => fixture.publicState(vaultState)
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () => currentPublicState())
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.mocked(keyringService.replaceQbitRecoveryMigrationPlans).mockImplementation(
      async (_address, _network, plans) => {
        vaultState = {
          ...vaultState,
          migration: { ...vaultState.migration, plans: plans.map(plan => ({ ...plan })) },
        }
        return currentPublicState()
      }
    )
    // The funding parent was reorged out and replaced: both the sweep and the
    // transaction that funded its input are definitively gone, and the address
    // history holds no conflicting spender for the planned outpoint.
    getAddressStatsMock.mockResolvedValue({
      address: fixture.sourceAccount.address,
      chain_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    getAddressHistoryMock.mockResolvedValue({ confirmed: [], mempool: [] })
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'gone' })
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(new Error('migration inputs are missing'))

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: { plans: [] },
    })

    expect(keyringService.replaceQbitRecoveryMigrationPlans).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      []
    )
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  /**
   * A migrating source whose single account holds `utxoCount` confirmed
   * outputs of `value` bits (50,000 by default, or `value[index]` for each),
   * with plan persistence applied to the shared vault.
   */
  function mockManyOutputRecoverySource(
    wallet: WalletController,
    fixture: ReturnType<typeof qbitRecoveryMigrationFixture>,
    plans: any[],
    utxoCount: number,
    value: number | readonly number[] = 50_000
  ) {
    const valueAt = (index: number) => (typeof value === 'number' ? value : value[index]!)
    const state = {
      vault: {
        ...fixture.vaultState,
        migration: { ...fixture.vaultState.migration, plans },
      } as any,
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: state.vault,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () =>
      fixture.publicState(state.vault)
    )
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(state.vault)
    )
    const applyPlans = async (_address: string, _network: string, next: any[]) => {
      state.vault = {
        ...state.vault,
        migration: { ...state.vault.migration, plans: next.map(plan => ({ ...plan })) },
      }
      return fixture.publicState(state.vault)
    }
    vi.mocked(keyringService.replaceQbitRecoveryMigrationPlans).mockImplementation(applyPlans)
    vi.mocked(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).mockImplementation(applyPlans)
    const txids = Array.from({ length: utxoCount }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0')
    )
    getAddressUtxosMock.mockResolvedValue(
      txids.map((txid, index) => ({
        txid,
        vout: 0,
        value: valueAt(index),
        status: { confirmed: true, block_height: 10 },
      }))
    )
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [
        {
          value: valueAt(txids.indexOf(txid)),
          scriptpubkey: fixture.sourceAccount.p2mr.scriptPubKey,
        },
      ],
    }))
    return { state, txids }
  }

  /** The source history holds only the funding transaction: no conflicting spender. */
  function mockSourceHistoryWithoutSpender(
    fixture: ReturnType<typeof qbitRecoveryMigrationFixture>
  ) {
    getAddressStatsMock.mockResolvedValue({
      address: fixture.sourceAccount.address,
      chain_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 50_000,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 1,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    getAddressHistoryMock.mockResolvedValue({
      confirmed: [
        { txid: fixture.sourceTxid, vin: [], status: { confirmed: true, block_height: 10 } },
      ],
      mempool: [],
    })
  }

  const planInputCount = (plan: any) =>
    decodePsbt(parsePsbt(hexToBytes(plan.psbtHex))).inputs.length

  it('splits a recovery sweep of more outputs than one standard transaction into several plans', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Probe B: a source account holding 150 sweepable outputs.
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 150)

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    const plans = state.vault.migration.plans
    expect(plans.map((plan: any) => plan.id)).toEqual([
      `${fixture.sourceAccount.pubkey}:0`,
      `${fixture.sourceAccount.pubkey}:1`,
    ])
    // Two batches are needed; the outputs are spread evenly over them.
    expect(plans.map(planInputCount)).toEqual([75, 75])
    // Both batches pay the same destination account, reserved once.
    expect(plans.map((plan: any) => plan.destinationIndex)).toEqual([0, 0])
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      expect.any(Array),
      expect.objectContaining({ reserveIndexes: [0], reuseIndexes: [] })
    )
    expect(prepared.toSignDatas.map(planInputCount)).toEqual([75, 75])
  })

  it('plans a source over the explorer UTXO limit from its history (#277)', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const source = fixture.sourceAccount
    // 620 confirmed outputs, of which history spends the first 30 again.
    const { state, txids } = mockManyOutputRecoverySource(wallet, fixture, [], 620)
    const listingRefused = new QbitApiError('http', 'HTTP 500 from /utxo', {
      status: 500,
      url: `http://127.0.0.1:3002/address/${source.address}/utxo`,
    })
    getAddressUtxosMock.mockRejectedValue(listingRefused)
    const output = (value: number, address = source.address) => ({
      scriptpubkey: address === source.address ? source.p2mr.scriptPubKey : `5220${'77'.repeat(32)}`,
      scriptpubkey_asm: '',
      scriptpubkey_type: 'v2_p2mr',
      scriptpubkey_address: address,
      value,
    })
    const historyTx = (txid: string, height: number, vin: any[], vout: any[]) => ({
      txid,
      version: 2,
      locktime: 0,
      vin,
      vout,
      size: 200,
      weight: 200,
      fee: 0,
      status: { confirmed: true, block_height: height },
    })
    const funding = txids.map((txid, index) =>
      historyTx(
        txid,
        10,
        [
          {
            txid: 'f0'.repeat(32),
            vout: index,
            prevout: null,
            scriptsig: '',
            scriptsig_asm: '',
            is_coinbase: false,
            sequence: 0xfffffffd,
          },
        ],
        [output(50_000)]
      )
    )
    const spend = historyTx(
      'e1'.repeat(32),
      11,
      txids.slice(0, 30).map(txid => ({
        txid,
        vout: 0,
        prevout: output(50_000),
        scriptsig: '',
        scriptsig_asm: '',
        is_coinbase: false,
        sequence: 0xfffffffd,
      })),
      [output(1_400_000, 'qbrt1zelsewhere')]
    )
    const sourceStats = {
      address: source.address,
      chain_stats: {
        funded_txo_count: 620,
        funded_txo_sum: 620 * 50_000,
        spent_txo_count: 30,
        spent_txo_sum: 30 * 50_000,
        tx_count: 621,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    }
    getAddressStatsMock.mockImplementation(async address =>
      address === source.address ? sourceStats : quietAddressStats(address)
    )
    getAddressHistoryMock.mockImplementation(async address =>
      address === source.address
        ? { confirmed: [spend, ...funding.reverse()], mempool: [] }
        : { confirmed: [], mempool: [] }
    )

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    // The 590 unspent outputs, no more and no fewer, in standard-size plans.
    const plans = state.vault.migration.plans
    expect(plans.map(planInputCount)).toEqual([99, 99, 98, 98, 98, 98])
    const planned = plans.flatMap((plan: any) =>
      decodePsbt(parsePsbt(hexToBytes(plan.psbtHex))).inputs.map(input =>
        reverseTxid(bytesToHex(input.prevout.txid))
      )
    )
    expect(new Set(planned)).toEqual(new Set(txids.slice(30)))
    expect(plans.map((plan: any) => plan.destinationIndex)).toEqual([0, 0, 0, 0, 0, 0])
    expect(prepared.toSignDatas).toHaveLength(6)
    // Twice the 10,000-row read: @qbit-oss/api counts its rescan against it.
    expect(getAddressHistoryMock).toHaveBeenCalledWith(
      source.address,
      expect.objectContaining({ maxTransactions: 20_000 })
    )
  })

  /**
   * A source the explorer will not list (620 confirmed unspent outputs) whose
   * history is longer than the 10,000 transactions the wallet reads.
   */
  function mockUnreadableRecoverySource(address: string) {
    const ordinary = getAddressUtxosMock.getMockImplementation()
    getAddressUtxosMock.mockImplementation(async (requested: string) => {
      if (requested === address) {
        throw new QbitApiError('http', 'HTTP 500 from /utxo', {
          status: 500,
          url: `http://127.0.0.1:3002/address/${address}/utxo`,
        })
      }
      return ordinary ? ordinary(requested) : []
    })
    const ordinaryStats = getAddressStatsMock.getMockImplementation()!
    getAddressStatsMock.mockImplementation(async (requested: string) =>
      requested === address
        ? {
            address,
            chain_stats: {
              funded_txo_count: 620,
              funded_txo_sum: 620 * 50_000,
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 10_001,
            },
            mempool_stats: {
              funded_txo_count: 0,
              funded_txo_sum: 0,
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 0,
            },
          }
        : ordinaryStats(requested)
    )
  }

  it('plans the other sources and reports one whose history is too long to read (#344)', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 3)
    // Read first, so its failure would stop the whole pass.
    const unreadable = p2mrAccount('43'.repeat(32), 1)
    fixture.sourceKeyring.accounts.unshift(unreadable as any)
    mockUnreadableRecoverySource(unreadable.address)

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(prepared.deferredSources).toEqual([
      { address: unreadable.address, reason: 'history_too_large', maxTransactions: 10_000 },
    ])
    // The readable source is planned as usual; the other one is not, and
    // nothing of its history was read past the statistics.
    expect(state.vault.migration.plans.map((plan: any) => plan.sourceAddress)).toEqual([
      fixture.sourceAccount.address,
    ])
    expect(prepared.toSignDatas).toHaveLength(1)
    expect(prepared.state.status).toBe('migrating')
    expect(getAddressHistoryMock).not.toHaveBeenCalledWith(unreadable.address, expect.anything())

    // With nothing else left to plan, the migration stays open and still names it.
    state.vault = {
      ...state.vault,
      migration: {
        ...state.vault.migration,
        plans: state.vault.migration.plans.map((plan: any) => ({ ...plan, status: 'confirmed' })),
      },
    }
    getAddressUtxosMock.mockResolvedValue([])
    mockUnreadableRecoverySource(unreadable.address)
    const again = await wallet.prepareQbitRecoveryMigration(2, 1)
    expect(again).toMatchObject({
      toSignDatas: [],
      deferredSources: [{ address: unreadable.address, reason: 'history_too_large' }],
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('keeps a migration open, and reopens an archived one, for a source too long to read (#344)', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const unreadable = p2mrAccount('43'.repeat(32), 1)
    fixture.sourceKeyring.accounts.push(unreadable as any)
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () =>
      fixture.publicState(vaultState)
    )
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.reopenQbitRecoveryMigration).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrating' }
      return fixture.publicState(vaultState)
    })
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    getAddressUtxosMock.mockResolvedValue([])
    mockUnreadableRecoverySource(unreadable.address)

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    // An archive whose source has since grown past the read limit reopens.
    vaultState = { ...vaultState, status: 'migrated' }
    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
    })
    expect(keyringService.reopenQbitRecoveryMigration).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      []
    )
  })

  /**
   * A source the explorer will not list (620 confirmed unspent outputs), short
   * enough to read from its history, whose history never reads in full: every
   * walk of it rejects with `invalid_cursor`, as mempool-qbit's did on whole
   * pages of pending rows.
   */
  function mockIncompleteRecoverySource(address: string) {
    mockUnreadableRecoverySource(address)
    const unreadableStats = getAddressStatsMock.getMockImplementation()!
    getAddressStatsMock.mockImplementation(async (requested: string) => {
      const stats = await unreadableStats(requested)
      return requested === address
        ? { ...stats, chain_stats: { ...stats.chain_stats, tx_count: 620 } }
        : stats
    })
    const ordinaryHistory = getAddressHistoryMock.getMockImplementation()
    getAddressHistoryMock.mockImplementation(async (requested: string, options: unknown) => {
      if (requested === address) {
        throw new QbitApiError(
          'invalid_cursor',
          `mempool-qbit address history returned 0 confirmed and 50 mempool transactions, but the address stats count 620 and 50: ${address}`
        )
      }
      return ordinaryHistory ? ordinaryHistory(requested, options) : { confirmed: [], mempool: [] }
    })
  }

  /** Run `call` on a fake clock that moves on while it waits, past the history read's retries. */
  async function withRetryTimers<T>(call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const result = call()
      result.then(
        () => (settled = true),
        () => (settled = true)
      )
      while (!settled) await vi.advanceTimersByTimeAsync(1_000)
      return await result
    } finally {
      vi.useRealTimers()
    }
  }

  const historyReadsOf = (address: string) =>
    getAddressHistoryMock.mock.calls.filter(([requested]) => requested === address)

  it('plans the other sources and reports one whose history it could not read in full', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 3)
    // Read first, so its failure would stop the whole pass.
    const incomplete = p2mrAccount('44'.repeat(32), 1)
    fixture.sourceKeyring.accounts.unshift(incomplete as any)
    mockIncompleteRecoverySource(incomplete.address)

    const prepared = await withRetryTimers(() => wallet.prepareQbitRecoveryMigration(2, 1))

    expect(prepared.deferredSources).toEqual([
      { address: incomplete.address, reason: 'history_incomplete' },
    ])
    // The read was retried before the source was deferred.
    expect(historyReadsOf(incomplete.address)).toHaveLength(3)
    // The readable source is planned as usual; the other one is not.
    expect(state.vault.migration.plans.map((plan: any) => plan.sourceAddress)).toEqual([
      fixture.sourceAccount.address,
    ])
    expect(prepared.toSignDatas).toHaveLength(1)
    expect(prepared.state.status).toBe('migrating')

    // With nothing else left to plan, the migration stays open and still names it.
    state.vault = {
      ...state.vault,
      migration: {
        ...state.vault.migration,
        plans: state.vault.migration.plans.map((plan: any) => ({ ...plan, status: 'confirmed' })),
      },
    }
    getAddressUtxosMock.mockResolvedValue([])
    mockIncompleteRecoverySource(incomplete.address)
    const again = await withRetryTimers(() => wallet.prepareQbitRecoveryMigration(2, 1))
    expect(again).toMatchObject({
      toSignDatas: [],
      deferredSources: [{ address: incomplete.address, reason: 'history_incomplete' }],
    })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('keeps a migration open for a source it could not read in full, and never reopens an archived one for it', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const incomplete = p2mrAccount('44'.repeat(32), 1)
    fixture.sourceKeyring.accounts.push(incomplete as any)
    let vaultState: any = {
      ...fixture.vaultState,
      migration: {
        ...fixture.vaultState.migration,
        plans: [{ ...fixture.vaultState.migration.plans[0], status: 'confirmed' }],
      },
    }
    vi.spyOn(wallet as any, 'loadQbitRecoveryMigration').mockImplementation(async () => ({
      sourceKeyring: fixture.sourceKeyring,
      anchor: fixture.sourceAccount,
      state: vaultState,
      network: 'regtest' as const,
      destination: fixture.destinationKeyring,
      destinationKeyringIndex: 3,
    }))
    vi.spyOn(wallet as any, 'getQbitKeyringByIndex').mockImplementation(async index =>
      index === 3 ? fixture.destinationKeyring : fixture.sourceKeyring
    )
    vi.spyOn(wallet, 'getQbitRecoveryState').mockImplementation(async () =>
      fixture.publicState(vaultState)
    )
    vi.mocked(keyringService.getQbitRecoveryVaultState).mockImplementation(async () =>
      wrapRegtestVaultState(vaultState)
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockResolvedValue({ state: 'confirmed' })
    vi.mocked(keyringService.reopenQbitRecoveryMigration).mockImplementation(async () => {
      vaultState = { ...vaultState, status: 'migrating' }
      return fixture.publicState(vaultState)
    })
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    getAddressUtxosMock.mockResolvedValue([])
    mockIncompleteRecoverySource(incomplete.address)

    await expect(
      withRetryTimers(() => wallet.advanceQbitRecoveryMigration(2))
    ).resolves.toMatchObject({ status: 'migrating' })
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()

    // On an archived wallet a read that did not settle is no evidence of
    // new funds: the check fails as it always did and stores nothing.
    vaultState = { ...vaultState, status: 'migrated' }
    await expect(
      withRetryTimers(() => wallet.advanceQbitRecoveryMigration(2))
    ).rejects.toMatchObject({ kind: 'invalid_cursor' })
    expect(keyringService.reopenQbitRecoveryMigration).not.toHaveBeenCalled()
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(vaultState.status).toBe('migrated')
  })

  it('leaves no small remainder batch that could not pay for itself', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Every 6,000-bit output is worth sweeping at 1 bit/vB, but a lone 107th
    // output would net 2,183 bits, under dust, and be left in the source.
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 107, 6_000)

    await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(state.vault.migration.plans.map(planInputCount)).toEqual([54, 53])
  })

  it('balances batches by value so small outputs are not grouped under dust', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Split 54/53 by count, the 53 smallest outputs would net 1,959 bits, under
    // dust. The large output alone and the 106 small ones both clear it.
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 107, [
      1_000_000,
      ...Array.from({ length: 106 }, () => 3_800),
    ])

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const plans = state.vault.migration.plans
    expect(plans.map(planInputCount)).toEqual([1, 106])
    expect(plans.map((plan: any) => plan.amount)).toEqual([996_183, 3_973])
  })

  it('moves the outputs of a batch under dust into a batch with room', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // However they are split, no batch of only 3,782-bit outputs pays dust,
    // so they join the large output up to the standard size.
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 107, [
      1_000_000,
      ...Array.from({ length: 106 }, () => 3_782),
    ])

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const plans = state.vault.migration.plans
    expect(plans.map(planInputCount)).toEqual([106])
    expect(plans.map((plan: any) => plan.amount)).toEqual([1_000_000 + 105 * 3_782 - 398_827])
  })

  it('sweeps one full batch when the balanced batches would each fall under dust', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    // Each 3,792-bit output nets 30 bits at 1 bit/vB: 54 or 53 of them cannot
    // pay a dust output, but 106 can.
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [], 107, 3_792)

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const plans = state.vault.migration.plans
    expect(plans.map(planInputCount)).toEqual([106])
    expect(plans.map((plan: any) => plan.amount)).toEqual([106 * 3_792 - 398_827])
  })

  /** An unsigned 107-input plan, from before sweeps were batched, on destination index 2. */
  async function oversizedPreparedPlan(fixture: ReturnType<typeof qbitRecoveryMigrationFixture>) {
    const oversizedPsbtHex = psbtHexWithDataOutputs(
      fixture.sourceAccount,
      [],
      Array.from({ length: 107 }, (_, index) => (index + 1).toString(16).padStart(64, '0'))
    )
    // The dropped plan had reserved destination index 2.
    const destination = await fixture.destinationRawKeyring.getQbitReceiveAccount(2)
    fixture.destinationRawKeyring.receiveIssuedIndexes.push(2)
    vi.mocked(keyringService.addNewAccount).mockImplementation(async () => {
      fixture.destinationRawKeyring.activeIndexes.push(
        fixture.destinationRawKeyring.activeIndexes.length
      )
      return []
    })
    return {
      id: `${fixture.sourceAccount.pubkey}:0`,
      sourcePubkey: fixture.sourceAccount.pubkey,
      sourceAddress: fixture.sourceAccount.address,
      destinationAddress: destination.addresses.regtest,
      amount: 10_000,
      fee: 107 * 50_000 - 10_000,
      psbtHex: oversizedPsbtHex,
      status: 'prepared' as const,
      sourceIndex: 0,
      destinationIndex: 2,
      destinationPubkey: destination.pubkey,
    }
  }

  it('drops an unsigned plan over the standard size and plans its outputs again in batches', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPlan = await oversizedPreparedPlan(fixture)
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [oversizedPlan], 107)

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    // The plan leaves the vault in the write that stores its replacements,
    // which never reuse its id.
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(state.vault.migration.plans.map((plan: any) => plan.id)).toEqual([
      `${fixture.sourceAccount.pubkey}:1`,
      `${fixture.sourceAccount.pubkey}:2`,
    ])
    expect(state.vault.migration.plans.map(planInputCount)).toEqual([54, 53])
    // The source keeps the destination its dropped plan reserved.
    expect(state.vault.migration.plans.map((plan: any) => plan.destinationIndex)).toEqual([2, 2])
    expect(
      keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations
    ).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      expect.any(Array),
      expect.objectContaining({ reserveIndexes: [], reuseIndexes: [2] })
    )
    expect(prepared.toSignDatas.map(planInputCount)).toEqual([54, 53])
  })

  it('keeps an oversized unsigned plan and its destination when a pass fails before replanning', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPlan = await oversizedPreparedPlan(fixture)
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [oversizedPlan], 107)
    getAddressUtxosMock.mockRejectedValueOnce(new Error('explorer unavailable'))

    await expect(wallet.prepareQbitRecoveryMigration(2, 1)).rejects.toThrow()

    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(state.vault.migration.plans).toEqual([oversizedPlan])

    await wallet.prepareQbitRecoveryMigration(2, 1)

    expect(state.vault.migration.plans.map((plan: any) => plan.destinationIndex)).toEqual([2, 2])
  })

  it('keeps an oversized unsigned plan whose source yields no batch while another source is planned', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPlan = await oversizedPreparedPlan(fixture)
    const { state, txids } = mockManyOutputRecoverySource(wallet, fixture, [oversizedPlan], 107)
    // A second source account is funded, while every output of the first is
    // guarded by a recent spend, so the first yields no batch this pass.
    const secondAccount = p2mrAccount('43'.repeat(32), 1)
    fixture.sourceKeyring.accounts = [fixture.sourceAccount, secondAccount]
    const secondTxid = 'ab'.repeat(32)
    const confirmedOutput = (txid: string) => ({
      txid,
      vout: 0,
      value: 50_000,
      status: { confirmed: true, block_height: 10 },
    })
    getAddressUtxosMock.mockImplementation(async (address: string) =>
      address === secondAccount.address ? [confirmedOutput(secondTxid)] : txids.map(confirmedOutput)
    )
    getTxMock.mockImplementation(async txid => ({
      txid,
      vin: [{ is_coinbase: false }],
      vout: [
        {
          value: 50_000,
          scriptpubkey: (txid === secondTxid ? secondAccount : fixture.sourceAccount).p2mr
            .scriptPubKey,
        },
      ],
    }))
    vi.mocked(qbitSendGuardService.getReservedOutpointKeys).mockImplementation(
      async (_chain, address) =>
        new Set(address === fixture.sourceAccount.address ? txids.map(txid => `${txid}:0`) : [])
    )

    await wallet.prepareQbitRecoveryMigration(2, 1)

    const plans = state.vault.migration.plans
    expect(plans.map((plan: any) => plan.id)).toEqual([
      oversizedPlan.id,
      `${secondAccount.pubkey}:0`,
    ])
    // The guarded source keeps the destination account it reserved.
    expect(plans[0].destinationIndex).toBe(2)
    expect(plans[1].destinationIndex).not.toBe(2)
  })

  it('drops an oversized unsigned plan whose outputs are gone before completing the migration', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPlan = await oversizedPreparedPlan(fixture)
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [oversizedPlan], 0)
    mockSourceHistoryWithoutSpender(fixture)
    vi.spyOn(wallet as any, 'activateQbitMigrationDestination').mockResolvedValue(undefined)

    await wallet.prepareQbitRecoveryMigration(2, 1)

    // The keyring only completes a migration whose plans all confirmed.
    expect(state.vault.migration.plans).toEqual([])
    expect(keyringService.markQbitRecoveryMigrated).toHaveBeenCalled()
    expect(
      vi.mocked(keyringService.replaceQbitRecoveryMigrationPlans).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(keyringService.markQbitRecoveryMigrated).mock.invocationCallOrder[0]!)
  })

  it('keeps an oversized unsigned plan out of signing until every other plan is done', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPlan = {
      id: `${fixture.sourceAccount.pubkey}:0`,
      sourcePubkey: fixture.sourceAccount.pubkey,
      sourceAddress: fixture.sourceAccount.address,
      destinationAddress: fixture.destinationAccount.address,
      amount: 10_000,
      fee: 107 * 50_000 - 10_000,
      psbtHex: psbtHexWithDataOutputs(
        fixture.sourceAccount,
        [],
        Array.from({ length: 107 }, (_, index) => (index + 1).toString(16).padStart(64, '0'))
      ),
      status: 'prepared' as const,
      sourceIndex: 0,
      destinationIndex: 0,
      destinationPubkey: fixture.destinationAccount.pubkey,
    }
    const pendingPlan = { ...fixture.vaultState.migration.plans[0], id: 'pending-plan' }
    const { state } = mockManyOutputRecoverySource(
      wallet,
      fixture,
      [oversizedPlan, pendingPlan],
      107
    )

    const prepared = await wallet.prepareQbitRecoveryMigration(2, 1)

    // The pending plan is still broadcast; the oversized one is neither
    // offered for signing nor dropped (and its pairing lost) yet.
    expect(prepared.toSignDatas).toEqual([])
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(state.vault.migration.plans.map((plan: any) => plan.id)).toEqual([
      oversizedPlan.id,
      pendingPlan.id,
    ])
  })

  it('retires a signed plan the node rejects as oversized instead of failing every advance', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const { state } = mockManyOutputRecoverySource(
      wallet,
      fixture,
      fixture.vaultState.migration.plans,
      0
    )
    // The sweep is gone while its funding parent is still confirmed and no
    // conflicting spender exists: before, nothing ever cleared such a plan.
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === fixture.vaultState.migration.plans[0].txid
        ? { state: 'gone' }
        : { state: 'confirmed' }
    )
    mockSourceHistoryWithoutSpender(fixture)
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(
      new QbitApiError('http', 'HTTP 400 from /tx', {
        status: 400,
        responseBody: 'sendrawtransaction RPC error: {"code":-26,"message":"tx-size"}',
      })
    )

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      status: 'migrating',
      migration: { plans: [] },
    })
    expect(keyringService.replaceQbitRecoveryMigrationPlans).toHaveBeenCalledWith(
      fixture.sourceAccount.address,
      'regtest',
      []
    )
    expect(state.vault.migration.plans).toEqual([])
    expect(keyringService.markQbitRecoveryMigrated).not.toHaveBeenCalled()
  })

  it('retires an oversized signed plan even when the explorer refuses the request body', async () => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const oversizedPsbtHex = psbtHexWithDataOutputs(
      fixture.sourceAccount,
      [],
      Array.from({ length: 107 }, (_, index) => (index + 1).toString(16).padStart(64, '0'))
    )
    const signedPlan = {
      ...fixture.vaultState.migration.plans[0],
      psbtHex: oversizedPsbtHex,
      signedPsbtHex: oversizedPsbtHex,
      status: 'signed' as const,
    }
    const { state } = mockManyOutputRecoverySource(wallet, fixture, [signedPlan], 0)
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === signedPlan.txid ? { state: 'gone' } : { state: 'confirmed' }
    )
    mockSourceHistoryWithoutSpender(fixture)
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(
      new QbitApiError('payload_too_large', 'HTTP 413 from /tx', { status: 413 })
    )

    await expect(wallet.advanceQbitRecoveryMigration(2)).resolves.toMatchObject({
      migration: { plans: [] },
    })
    expect(state.vault.migration.plans).toEqual([])
  })

  it.each([
    ['a mempool-dependent reason', 'mempool min fee not met'],
    // Re-planning rebuilds about the same output, so a dust verdict would
    // only repeat after another round of signatures.
    ['a dust output', 'dust'],
  ])('keeps a signed plan whose rebroadcast is refused for %s', async (_label, reason) => {
    const wallet = new WalletController()
    const fixture = qbitRecoveryMigrationFixture()
    const { state } = mockManyOutputRecoverySource(
      wallet,
      fixture,
      fixture.vaultState.migration.plans,
      0
    )
    vi.spyOn(wallet, 'getQbitTxLifecycleStatus').mockImplementation(async txid =>
      txid === fixture.vaultState.migration.plans[0].txid
        ? { state: 'gone' }
        : { state: 'confirmed' }
    )
    mockSourceHistoryWithoutSpender(fixture)
    const rejection = new QbitApiError('http', 'HTTP 400 from /tx', {
      status: 400,
      responseBody: `sendrawtransaction RPC error: {"code":-26,"message":"${reason}"}`,
    })
    vi.spyOn(wallet, 'pushTx').mockRejectedValue(rejection)

    await expect(wallet.advanceQbitRecoveryMigration(2)).rejects.toBe(rejection)
    expect(keyringService.replaceQbitRecoveryMigrationPlans).not.toHaveBeenCalled()
    expect(state.vault.migration.plans).toEqual(fixture.vaultState.migration.plans)
  })

  it('resolves migration sweep fee rates from the live estimate with a relay-floor fallback', async () => {
    await expect(
      (new WalletController() as any).resolveQbitRecoveryMigrationFeeRate()
    ).resolves.toBe(3)

    getFeeTiersMock.mockRejectedValue(new Error('estimate unavailable'))
    await expect(
      (new WalletController() as any).resolveQbitRecoveryMigrationFeeRate()
    ).resolves.toBe(1)
  })

  it('does not call the generic decoder when Qbit PSBT decoding fails', async () => {
    const wallet = new WalletController()

    await expect(wallet.decodePsbt('deadbeef', 'https://example.test')).rejects.toThrow(
      /qbit P2MR PSBT/
    )
    expect(walletApiService.transactionCore.decodePsbt).not.toHaveBeenCalled()
  })

  it('broadcasts qbit transactions through the qbit Esplora client', async () => {
    const wallet = new WalletController()
    const account = p2mrAccount()
    const sourceTxid = `01${'00'.repeat(31)}`
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    const pubkey = hexToBytes(account.pubkey)
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: hexToBytes(reverseTxid(sourceTxid)), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
    })
    const signed = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
    }).psbt
    const rawTx = extractP2mrTransaction(finalizeP2mrPsbt(signed))
    const rawTxHex = bytesToHex(rawTx)
    const txid = transactionCore.Transaction.fromBuffer(Buffer.from(rawTx)).getId()
    broadcastTxMock.mockResolvedValueOnce(txid)

    await expect(wallet.pushTx(rawTxHex)).resolves.toBe(txid)

    expect(esploraClientMock).toHaveBeenCalled()
    expect(broadcastTxMock).toHaveBeenCalledWith(rawTxHex)
    expect(qbitSendGuardService.broadcastIfAllowed).toHaveBeenCalledWith(
      ChainType.QBIT_REGTEST,
      txid,
      [{ txid: sourceTxid, vout: 0 }],
      expect.any(Function)
    )
    expect(walletApiService.transactionCore.pushTx).not.toHaveBeenCalled()
  })

  it('marks a qbit transaction gone for a definitive API 404', async () => {
    const wallet = new WalletController()
    getTxStatusMock.mockRejectedValueOnce(
      new QbitApiError('not_found', 'transaction not found', { status: 404 })
    )

    await expect(wallet.getQbitTxLifecycleStatus('missing-tx')).resolves.toEqual({
      state: 'gone',
    })
  })

  it('marks an evicted qbit transaction gone when only its unconfirmed status is stale', async () => {
    const wallet = new WalletController()
    getTxStatusMock.mockResolvedValueOnce({ confirmed: false })
    getTxMock.mockRejectedValueOnce(
      new QbitApiError('not_found', 'transaction not found', { status: 404 })
    )

    await expect(wallet.getQbitTxLifecycleStatus('evicted-tx')).resolves.toEqual({
      state: 'gone',
    })
  })

  it('requires a live transaction body before reporting a qbit transaction pending', async () => {
    const wallet = new WalletController()
    getTxStatusMock.mockResolvedValueOnce({ confirmed: false })
    getTxMock.mockResolvedValueOnce({ txid: 'pending-tx' })

    await expect(wallet.getQbitTxLifecycleStatus('pending-tx')).resolves.toEqual({
      state: 'pending',
    })
  })

  it('propagates transient transaction lookup failures after an unconfirmed status', async () => {
    const wallet = new WalletController()
    const error = new QbitApiError('network', 'offline')
    getTxStatusMock.mockResolvedValueOnce({ confirmed: false })
    getTxMock.mockRejectedValueOnce(error)

    await expect(wallet.getQbitTxLifecycleStatus('pending-tx')).rejects.toBe(error)
  })

  it.each([
    ['network', new QbitApiError('network', 'offline')],
    ['parse', new QbitApiError('parse', 'invalid response')],
    ['server', new QbitApiError('http', 'server error', { status: 500 })],
    ['incomplete not-found', new QbitApiError('not_found', 'missing status')],
    ['unknown', new Error('unexpected failure')],
  ])('propagates %s errors while probing qbit transaction lifecycle', async (_label, error) => {
    const wallet = new WalletController()
    getTxStatusMock.mockRejectedValueOnce(error)

    await expect(wallet.getQbitTxLifecycleStatus('pending-tx')).rejects.toBe(error)
  })
})
