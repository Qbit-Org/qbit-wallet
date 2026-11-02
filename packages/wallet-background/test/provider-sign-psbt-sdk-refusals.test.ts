import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import rpcFlow from '../src/controllers/provider/rpcFlow'
import wallet from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'

// The real provider flow, provider controller, wallet controller and send
// guard, for website PSBTs that @qbit-oss/protocol refuses because qbit Core
// would: the website gets the refusal before the approval window opens and
// before any signature counter is reserved.
const approvalServiceMock = vi.hoisted(() => ({ requestApproval: vi.fn(), unLock: vi.fn() }))

vi.mock('@qbit-oss/pqc', async importOriginal => ({
  ...(await importOriginal<typeof import('@qbit-oss/pqc')>()),
  verify: vi.fn(() => true),
}))
vi.mock('src/services/approval', () => ({ default: approvalServiceMock }))
vi.mock('src/utils/eventBus', () => ({ bgEventBus: { emit: vi.fn() } }))
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      hasVault: vi.fn(() => true),
      memStore: { getState: vi.fn(() => ({ isUnlocked: true })) },
      getQbitRecoveryState: vi.fn(async () => undefined),
      preflightP2mrPsbtSigning: vi.fn(),
      signP2mrPsbtWithCounter: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
    },
    permissionService: {
      hasPermission: vi.fn(() => true),
      touchConnectedSite: vi.fn(),
      updateConnectSite: vi.fn(),
    },
    qbitSendGuardService: guard,
    walletApiService: { transactionCore: { pushTx: vi.fn(), decodePsbt: vi.fn() } },
    sessionService: {},
    contactBookService: {},
    notificationService: {},
  }
})

const ORIGIN = 'https://dapp.example'
const PUBKEY_HEX = '11'.repeat(32)
const LEAF_SCRIPT = singleKeyLeafScript(hexToBytes(PUBKEY_HEX))
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const ACCOUNT_SCRIPT = p2mrScriptPubKey(LEAF_HASH)
const RECIPIENT_SCRIPT = p2mrScriptPubKey(hexToBytes('77'.repeat(32)))
const FUNDING_TXID = '98'.repeat(32)

const account = {
  type: KeyringType.QbitHdKeyring,
  address: p2mrAddressFromPubkey(hexToBytes(PUBKEY_HEX), 'regtest'),
  pubkey: PUBKEY_HEX,
  key: 'account-0',
  flag: 0,
  index: 0,
  p2mr: {
    pubkey: PUBKEY_HEX,
    leafScript: bytesToHex(LEAF_SCRIPT),
    scriptPubKey: bytesToHex(ACCOUNT_SCRIPT),
    signatureCounter: { count: 0, limit: 30, remaining: 30, state: 'normal' },
  },
}

/** A website PSBT spending outputs 0 and 1 of one funding transaction. */
function twoInputPsbt() {
  const input = (vout: number) => ({
    prevout: { txid: hexToBytes(FUNDING_TXID), vout },
    witnessUtxo: { value: 500_000n, scriptPubKey: ACCOUNT_SCRIPT },
    leafScript: LEAF_SCRIPT,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  })
  return createP2mrPsbt({
    inputs: [input(0), input(1)],
    outputs: [{ value: 980_000n, scriptPubKey: RECIPIENT_SCRIPT }],
  })
}

/** `twoInputPsbt` with input 1's outpoint, in the unsigned transaction, replaced. */
function withSecondPrevout(prevoutHex: string): string {
  const hex = bytesToHex(serializePsbt(twoInputPsbt()))
  const second = `${FUNDING_TXID}01000000`
  expect(hex.split(second)).toHaveLength(2)
  return hex.replace(second, prevoutHex)
}

/** `twoInputPsbt` without its output, in the unsigned transaction and the PSBT. */
function withoutOutputs(): string {
  const psbt = twoInputPsbt()
  const unsignedTx = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === 0x00)!
  // Version, input count and two inputs (outpoint, empty script, sequence).
  const inputsEnd = 4 + 1 + 2 * (32 + 4 + 1 + 4)
  expect(unsignedTx.value[inputsEnd]).toBe(1)
  unsignedTx.value = Uint8Array.from([
    ...unsignedTx.value.subarray(0, inputsEnd),
    0,
    ...unsignedTx.value.subarray(-4),
  ])
  psbt.outputs = []
  return bytesToHex(serializePsbt(psbt))
}

function signPsbtRequest(psbtHex: string) {
  return {
    data: {
      method: 'signPsbt',
      params: { psbtHex, options: { chain: ChainType.QBIT_REGTEST } },
    },
    session: { origin: ORIGIN, name: 'Dapp', icon: '' },
  }
}

function expectNothingReserved() {
  expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
  expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
}

describe('website PSBTs qbit Core would refuse', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await qbitSendGuardService.resetAllData()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    vi.spyOn(wallet, 'getAccounts').mockResolvedValue([account] as any)
    vi.spyOn(wallet, 'getFeeSummary').mockRejectedValue(new Error('no quote'))
    approvalServiceMock.requestApproval.mockRejectedValue(new Error('approval must not open'))
  })

  it.each([
    [
      'two inputs spending one output',
      () => withSecondPrevout(`${FUNDING_TXID}00000000`),
      /bad-txns-inputs-duplicate/,
    ],
    [
      'an input spending the null outpoint',
      () => withSecondPrevout(`${'00'.repeat(32)}ffffffff`),
      /bad-txns-prevout-null/,
    ],
    ['a transaction without outputs', withoutOutputs, /bad-txns-vout-empty/],
  ])('refuses %s, naming the rule, before approval', async (_shape, psbtHex, rule) => {
    const error = await rpcFlow(signPsbtRequest(psbtHex())).then(
      () => undefined,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(rule)
    expectNothingReserved()
  })

  it('refuses a PSBT key with data after a type that qbit Core requires alone', async () => {
    const psbt = twoInputPsbt()
    // PSBT_IN_FINAL_SCRIPTWITNESS (0x08) with a stray key byte: Core refuses
    // the PSBT ("key is more than one byte type").
    psbt.inputs[0]!.push({ key: Uint8Array.of(0x08, 0x00), value: Uint8Array.of(0x00) })

    await expect(rpcFlow(signPsbtRequest(bytesToHex(serializePsbt(psbt))))).rejects.toThrow(
      'invalid psbt'
    )
    expectNothingReserved()
  })
})
