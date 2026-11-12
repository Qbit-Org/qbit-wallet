import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import {
  BUS_EVENTS,
  BUS_METHODS,
  ErrorCodes,
  KeyringType,
  type ToSignData,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

const keyringState = vi.hoisted(() => ({ isUnlocked: true }))

// The send guard is the real service; the keyring signs with dummy
// signatures and reports progress the way the real one does.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      memStore: { getState: () => ({ isUnlocked: keyringState.isUnlocked }) },
      hasVault: () => true,
      setLocked: vi.fn(async () => {
        keyringState.isUnlocked = false
      }),
      signP2mrPsbtWithCounter: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 2),
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn() },
    contactBookService: {},
    permissionService: {},
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const pubkeyHex = '11'.repeat(32)
const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const accountScript = p2mrScriptPubKey(leafHash)
const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'regtest')
const account = {
  type: KeyringType.QbitHdKeyring,
  pubkey: pubkeyHex,
  address,
  key: 'account-0',
  flag: 0,
  index: 0,
  p2mr: {
    pubkey: pubkeyHex,
    path: `m/87'/1'/0'/0/0`,
    scriptPubKey: bytesToHex(accountScript),
    leafScript: bytesToHex(leafScript),
    addresses: { regtest: address },
    hkdf: { account: 0, change: 0, index: 0 },
  },
}

let sendSeed = 0

/** A two-input send to the account itself, spending outputs no other test spends. */
function twoInputSend(): ToSignData {
  sendSeed += 1
  const psbt = createP2mrPsbt({
    inputs: [0, 1].map(vout => ({
      prevout: { txid: new Uint8Array(32).fill(sendSeed), vout },
      witnessUtxo: { value: 100_000n, scriptPubKey: accountScript },
      leafScript,
      controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
      merkleRoot: leafHash,
    })),
    outputs: [{ value: 190_000n, scriptPubKey: accountScript }],
  })
  return {
    psbtHex: bytesToHex(serializePsbt(psbt)),
    toSignInputs: [0, 1].map(index => ({ index, publicKey: pubkeyHex })),
    qbitP2mrSigningKeys: [0, 1].map(inputIndex => ({
      inputIndex,
      publicKey: pubkeyHex,
      leafHash: bytesToHex(leafHash),
    })),
    autoFinalized: true,
  }
}

type SignerArgs = Parameters<typeof keyringService.signP2mrPsbtWithCounter>

/** Sign every input with a dummy signature, reporting each as the keyring does. */
async function dummySigner(...[, { psbt, keys }, , , options]: SignerArgs) {
  options?.onProgress?.(0, keys.length, 0)
  keys.forEach((_, index) => options?.onProgress?.(index + 1, keys.length, 0))
  return {
    psbt: signP2mrPsbt({
      psbt,
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
    }).psbt,
    signed: [],
    counterResults: [],
  }
}

describe('WalletController local signing progress (#171)', () => {
  let wallet: WalletController
  let pageMessages: Array<{ port: unknown; method: string; params: unknown }>
  let broadcastMethods: string[]
  const recordPageMessage = (message: any) => pageMessages.push(message)
  const recordBroadcast = ({ method }: { method: string }) => broadcastMethods.push(method)
  const signer = () => vi.mocked(keyringService.signP2mrPsbtWithCounter)

  beforeEach(() => {
    vi.clearAllMocks()
    keyringState.isUnlocked = true
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    signer().mockImplementation(dummySigner as any)
    wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
    pageMessages = []
    broadcastMethods = []
    bgEventBus.addEventListener(BUS_EVENTS.toUIPort, recordPageMessage)
    bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, recordBroadcast)
  })

  afterEach(() => {
    bgEventBus.removeEventListener(BUS_EVENTS.toUIPort, recordPageMessage)
    bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, recordBroadcast)
    clearTimeout(wallet.timer)
  })

  it('sends each input to the page that asked for it, tagged with its id', async () => {
    const signed = await wallet.runForUiPort(
      'popup:3',
      () => wallet.signPsbtV2(twoInputSend(), { progressId: 'signing-1' }),
      'signPsbtV2'
    )

    expect(signed.psbtHex).toBeTruthy()
    expect(pageMessages).toEqual(
      [0, 1, 2].map(count => ({
        port: 'popup:3',
        method: BUS_METHODS.QBIT_SIGNING_PROGRESS,
        params: { progressId: 'signing-1', signed: count, total: 2, cached: 0 },
      }))
    )
    // Never sent to every page.
    expect(broadcastMethods).not.toContain(BUS_METHODS.QBIT_SIGNING_PROGRESS)
  })

  it('passes the progress id through a batch entry signed for the page', async () => {
    const toSignData = twoInputSend()
    vi.spyOn(wallet as any, 'readQbitPsbtReviewContext').mockResolvedValue({
      account,
      chain: ChainType.QBIT_REGTEST,
    })
    vi.spyOn(wallet as any, 'analyzeLocalQbitPsbts').mockReturnValue({
      items: [{ parseError: false, risks: [] }],
    })

    await wallet.runForUiPort(
      'tab:5',
      () =>
        wallet.signLocalBatchPsbt(
          toSignData,
          { account: address, chain: ChainType.QBIT_REGTEST, confirmedRisks: [] },
          { progressId: 'batch-entry-0' }
        ),
      'signLocalBatchPsbt'
    )

    expect(pageMessages.map(message => message.port)).toEqual(['tab:5', 'tab:5', 'tab:5'])
    expect(pageMessages.at(-1)?.params).toEqual({
      progressId: 'batch-entry-0',
      signed: 2,
      total: 2,
      cached: 0,
    })
  })

  it.each([
    ['without an id', undefined],
    ['for an id with a space', 'signing 1'],
    ['for an id over 64 characters', 'x'.repeat(65)],
    ['for an id that is not text', 7],
  ])('reports nothing %s', async (_, progressId) => {
    await wallet.runForUiPort(
      'popup:3',
      () => wallet.signPsbtV2(twoInputSend(), { progressId } as any),
      'signPsbtV2'
    )

    expect(signer().mock.calls[0]![4]?.onProgress).toBeUndefined()
    expect(pageMessages).toEqual([])
  })

  it('reports nothing for a call that came through no page', async () => {
    await wallet.signPsbtV2(twoInputSend(), { progressId: 'signing-1' })

    expect(signer().mock.calls[0]![4]?.onProgress).toBeUndefined()
    expect(pageMessages).toEqual([])
  })

  it('stops the signing of a page that closes, before its next input', async () => {
    let closePage: () => void = () => undefined
    const pageClosed = new Promise<void>(resolve => (closePage = resolve))
    let stoppedBeforeNextInput: boolean | undefined
    signer().mockImplementation(async (...[, , , , options]: SignerArgs) => {
      await pageClosed
      stoppedBeforeNextInput = options?.signal?.aborted
      throw new Error('stopped')
    })

    const signing = wallet.runForUiPort(
      'popup:3',
      () => wallet.signPsbtV2(twoInputSend()),
      'signPsbtV2'
    )
    await vi.waitFor(() => expect(signer()).toHaveBeenCalledTimes(1))
    // Fired, as the messaging layer does: each release waits in the send
    // guard's queue behind the signing, but the stop itself is immediate.
    // Another page closing leaves the signing alone.
    const otherPageClosed = wallet.onUiPortDisconnected('tab:9')
    expect(signer().mock.calls[0]![4]?.signal?.aborted).toBe(false)

    const pageClosedDone = wallet.onUiPortDisconnected('popup:3')
    expect(signer().mock.calls[0]![4]?.signal?.aborted).toBe(true)
    closePage()
    await expect(signing).rejects.toThrow('stopped')
    await Promise.all([otherPageClosed, pageClosedDone])
    expect(stoppedBeforeNextInput).toBe(true)
    expect((wallet as any).localSignings.size).toBe(0)
  })

  it('stops at once, before any signature, a call whose page closed before it arrived', async () => {
    await wallet.onUiPortDisconnected('popup:7')

    await expect(
      wallet.runForUiPort('popup:7', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')
    ).rejects.toMatchObject({ code: 'QBIT_SIGNING_ABORTED' })

    expect(signer()).not.toHaveBeenCalled()
    expect((wallet as any).localSignings.size).toBe(0)
  })

  describe('during the checks before signing', () => {
    /** A consolidation batch: its inputs are checked against the explorer before signing. */
    function consolidationBatch(): ToSignData {
      return {
        ...twoInputSend(),
        qbitConsolidation: {
          confirmedOutputCount: 600,
          outputLimit: 500,
          amount: 190_000,
          fundingOutputCounts: [2, 2],
        },
      }
    }

    function holdTheCheck() {
      let finishCheck: () => void = () => undefined
      const check = new Promise<void>(resolve => (finishCheck = resolve))
      const spy = vi
        .spyOn(wallet as any, 'assertQbitConsolidationInputsUnspent')
        .mockReturnValue(check)
      return { spy, finishCheck }
    }

    it('holds the auto-lock from the start of the call, and stops holding when its page closes', async () => {
      const { spy, finishCheck } = holdTheCheck()

      const signing = wallet.runForUiPort(
        'popup:3',
        () => wallet.signPsbtV2(consolidationBatch()),
        'signPsbtV2'
      )
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
      // Registered from the start of the call, before any signature.
      expect((wallet as any).signingsHoldingAutoLock()).toBe(1)

      void wallet.onUiPortDisconnected('popup:3')
      expect((wallet as any).signingsHoldingAutoLock()).toBe(0)
      finishCheck()

      await expect(signing).rejects.toMatchObject({ code: 'QBIT_SIGNING_ABORTED' })
    })

    it('skips them for a call whose page closed before it arrived', async () => {
      const { spy } = holdTheCheck()
      await wallet.onUiPortDisconnected('popup:3')

      await expect(
        wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(consolidationBatch()), 'signPsbtV2')
      ).rejects.toMatchObject({ code: 'QBIT_SIGNING_ABORTED' })
      expect(spy).not.toHaveBeenCalled()
      expect(signer()).not.toHaveBeenCalled()
    })

    it('does not join the queue when its page closes during them', async () => {
      const { spy, finishCheck } = holdTheCheck()
      const signing = wallet.runForUiPort(
        'popup:3',
        () => wallet.signPsbtV2(consolidationBatch()),
        'signPsbtV2'
      )
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

      void wallet.onUiPortDisconnected('popup:3')
      finishCheck()

      await expect(signing).rejects.toMatchObject({ code: 'QBIT_SIGNING_ABORTED' })
      expect(signer()).not.toHaveBeenCalled()
    })

    it('says the wallet locked when a lock comes there', async () => {
      vi.spyOn(wallet as any, 'assertQbitConsolidationInputsUnspent').mockImplementation(
        async () => {
          await wallet.lockWallet()
          throw new Error('The account changed')
        }
      )

      await expect(
        wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(consolidationBatch()), 'signPsbtV2')
      ).rejects.toMatchObject({ code: ErrorCodes.WALLET_LOCKED_DURING_SIGNING })
      expect(signer()).not.toHaveBeenCalled()
    })
  })

  it("holds the auto-lock from a batch entry's own review read", async () => {
    let holdingDuringRead: number | undefined
    vi.spyOn(wallet as any, 'readQbitPsbtReviewContext').mockImplementation(async () => {
      holdingDuringRead = (wallet as any).signingsHoldingAutoLock()
      throw new Error('read failed')
    })

    await expect(
      wallet.runForUiPort(
        'tab:5',
        () =>
          wallet.signLocalBatchPsbt(twoInputSend(), {
            account: address,
            chain: ChainType.QBIT_REGTEST,
            confirmedRisks: [],
          }),
        'signLocalBatchPsbt'
      )
    ).rejects.toThrow('read failed')
    expect(holdingDuringRead).toBe(1)
    expect((wallet as any).localSignings.size).toBe(0)
  })

  it("says the wallet locked when a lock comes during a batch entry's review read", async () => {
    vi.spyOn(wallet as any, 'readQbitPsbtReviewContext').mockImplementation(async () => {
      await wallet.lockWallet()
      throw new Error('The current account or network changed after the batch was reviewed')
    })

    await expect(
      wallet.runForUiPort(
        'tab:5',
        () =>
          wallet.signLocalBatchPsbt(twoInputSend(), {
            account: address,
            chain: ChainType.QBIT_REGTEST,
            confirmedRisks: [],
          }),
        'signLocalBatchPsbt'
      )
    ).rejects.toMatchObject({ code: ErrorCodes.WALLET_LOCKED_DURING_SIGNING })
  })

  it('remembers only the most recently closed pages', async () => {
    for (let index = 0; index < 300; index++) await wallet.onUiPortDisconnected(`popup:${index}`)

    const closed: Set<string> = (wallet as any).closedUiPorts
    expect(closed.size).toBe(256)
    expect(closed.has('popup:299')).toBe(true)
    expect(closed.has('popup:0')).toBe(false)
  })

  it('counts as a signing for the auto-lock while the keyring signs', async () => {
    const running: number[] = []
    signer().mockImplementation(async (...args: SignerArgs) => {
      running.push((wallet as any).localSignings.size)
      return dummySigner(...args)
    })

    await wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')

    expect(running).toEqual([1])
    expect((wallet as any).localSignings.size).toBe(0)
  })

  it('says the wallet locked when a lock stops the signing', async () => {
    signer().mockImplementation(async () => {
      await wallet.lockWallet()
      // What the vault write after the next signature hits once locked.
      throw new Error('KeyringController - password is not a string')
    })

    await expect(
      wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')
    ).rejects.toMatchObject({ code: ErrorCodes.WALLET_LOCKED_DURING_SIGNING })
    expect((wallet as any).localSignings.size).toBe(0)
  })

  it('keeps the code of an error that has one, even when a lock came first', async () => {
    signer().mockImplementation(async () => {
      await wallet.lockWallet()
      throw Object.assign(new Error('Confirm the restored-floor risk again'), {
        code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED',
      })
    })

    await expect(
      wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')
    ).rejects.toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
  })

  it('keeps the error of a signing that fails with no lock during it', async () => {
    // Locked before the signing started: no lock happened while it ran.
    keyringState.isUnlocked = false
    signer().mockRejectedValue(new Error('The wallet is locked'))

    await expect(
      wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')
    ).rejects.toThrow('The wallet is locked')
  })

  it('passes any other signing failure on unchanged', async () => {
    signer().mockRejectedValue(new Error('forced signer failure'))

    await expect(
      wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(twoInputSend()), 'signPsbtV2')
    ).rejects.toThrow('forced signer failure')
  })
})
