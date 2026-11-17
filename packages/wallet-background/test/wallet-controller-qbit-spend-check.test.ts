import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { ErrorCodes, KeyringType, type ToSignData } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { UI_CONTROLLER_METHODS } from '../src/controllers/ui-access'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The check of the inputs a transaction spends (#210), through the wallet
// controller: the send screen lists the account's outputs without reading
// the deep ones' transactions, and every input a send, a send of everything
// or a page's PSBT spends is read and checked against its funding
// transaction before it is built and again before its first signature,
// whatever the page said of it. The send guard is the real service and the
// explorer a fake served over fetch; the keyring signs with dummy
// signatures.

const lock = vi.hoisted(() => ({ isUnlocked: true }))

vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      memStore: { getState: () => lock },
      hasVault: () => true,
      // Marks the wallet locked at once, as the keyring service does.
      setLocked: vi.fn(async () => {
        lock.isUnlocked = false
      }),
      preflightP2mrPsbtSigning: vi.fn(async (_address: string, { keys }: { keys: unknown[] }) => ({
        required: keys.length,
        cached: 0,
        remainingBefore: 1_000_000,
        remainingAfter: 1_000_000 - keys.length,
        limit: 1_073_741_824,
      })),
      signP2mrPsbtWithCounter: vi.fn(),
      getQbitRecoveryState: vi.fn(async () => null),
      getAllDisplayedKeyrings: vi.fn(async () => []),
      removeKeyring: vi.fn(async () => undefined),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 2),
      getCurrentKeyringIndex: vi.fn(() => 0),
      removeKeyringAlianName: vi.fn(),
      removeKeyringColor: vi.fn(),
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn(), broadcastChainChange: vi.fn() },
    contactBookService: {},
    permissionService: {},
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

function p2mrAccount(pubkeyHex: string) {
  const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'regtest')
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address,
    key: `account-${pubkeyHex.slice(0, 2)}`,
    flag: 0,
    index: 0,
    leafHash,
    p2mr: {
      pubkey: pubkeyHex,
      path: `m/87'/1'/0'/0/0`,
      scriptPubKey: bytesToHex(p2mrScriptPubKey(leafHash)),
      leafScript: bytesToHex(leafScript),
      addresses: { regtest: address },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1_073_741_824,
        remaining: 1_073_741_824,
        state: 'normal',
        provenance: 'local',
      },
    },
  }
}

const account = p2mrAccount('11'.repeat(32))
const otherAccount = p2mrAccount('22'.repeat(32))
const address = account.address
const script = account.p2mr.scriptPubKey
const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')

/** How a check failure reads: its cause (`QbitSpendInputProblem`). */
const failedFor = (problem: string) => expect.objectContaining({ problem })

describe('WalletController checks the inputs a transaction spends (#210)', () => {
  let explorer: FakeQbitExplorer
  /** While set, every transaction lookup waits for it. */
  let gate: Promise<void> | undefined
  let openGate: () => void = () => undefined
  let lookupArrived: () => void = () => undefined

  const isLookup = (path: string) => /^\/tx\/[0-9a-f]{64}$/.test(path)
  const lookups = () => explorer.requests.filter(({ path }) => isLookup(path)).length
  const tipReads = () =>
    explorer.requests.filter(({ path }) => path === '/blocks/tip/height').length

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    if (gate && isLookup(url.pathname.replace(/^\/api/, ''))) {
      lookupArrived()
      await gate
    }
    return explorer.fetch(input, init)
  }

  /** Hold every lookup from now on; resolves once one has arrived. */
  function holdLookups(): Promise<void> {
    gate = new Promise(resolve => (openGate = resolve))
    return new Promise(resolve => (lookupArrived = resolve))
  }

  function releaseLookups(): void {
    gate = undefined
    openGate()
  }

  /** `count` confirmed outputs paying the account, each its own transaction's, `height` deep. */
  function fund(
    count: number,
    { salt = 0, value = 50_000, height = 100, coinbase = false } = {}
  ): { txid: string; vout: number; satoshis: number }[] {
    return Array.from({ length: count }, (_, index) => {
      const txid = fakeTxid(index, salt)
      explorer.addTx({
        txid,
        inputs: coinbase ? [] : [{ txid: fakeTxid(index, salt + 5_000_000), vout: 0 }],
        outputs: [{ address, script, value: value + index }],
        height,
        coinbase,
      })
      return { txid, vout: 0, satoshis: value + index }
    })
  }

  /** What the page holds of `outputs` and hands back to a builder. */
  function provided(outputs: readonly { txid: string; vout: number; satoshis: number }[]) {
    return outputs.map(output => ({
      ...output,
      scriptPk: script,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    }))
  }

  function send(wallet: WalletController, qbitUtxos: ReturnType<typeof provided>, amount = 10_000) {
    return wallet.createSendQbitPsbt({
      to: recipient,
      amount,
      feeRate: 1,
      qbitUtxos,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxoAddress: address,
    })
  }

  function sendAll(wallet: WalletController, qbitUtxos: ReturnType<typeof provided>) {
    return wallet.createSendAllQbitPsbt({
      to: recipient,
      feeRate: 1,
      qbitUtxos,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxoAddress: address,
    })
  }

  /** `toSignData` with its PSBT's first input claiming `satoshis`: the same txid, another sighash. */
  function withInputValue(toSignData: ToSignData, satoshis: number): ToSignData {
    const summary = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex)))
    const leafScript = hexToBytes(account.p2mr.leafScript)
    const psbt = createP2mrPsbt({
      inputs: summary.inputs.map((input, index) => ({
        prevout: input.prevout,
        sequence: input.sequence,
        witnessUtxo: {
          value: index === 0 ? BigInt(satoshis) : input.witnessUtxo!.value,
          scriptPubKey: input.witnessUtxo!.scriptPubKey,
        },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: account.leafHash,
      })),
      outputs: summary.outputs.map(output => ({
        value: output.value,
        scriptPubKey: output.scriptPubKey,
      })),
    })
    return { ...toSignData, psbtHex: bytesToHex(serializePsbt(psbt)) }
  }

  const signer = () => vi.mocked(keyringService.signP2mrPsbtWithCounter)
  const preflight = () => vi.mocked(keyringService.preflightP2mrPsbtSigning)

  beforeEach(async () => {
    vi.clearAllMocks()
    lock.isUnlocked = true
    gate = undefined
    explorer = new FakeQbitExplorer('esplora')
    explorer.utxoLimit = 50_000
    explorer.registerAddress(address, script)
    vi.stubGlobal('fetch', fetchFn)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    signer().mockImplementation((async (
      _address: string,
      { psbt, keys }: { psbt: any; keys: any[] }
    ) => ({
      psbt: signP2mrPsbt({ psbt, keys, sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7) })
        .psbt,
      signed: [],
      counterResults: [],
    })) as any)
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    releaseLookups()
    vi.unstubAllGlobals()
    await qbitSendGuardService.resetAllData()
  })

  describe('the send screen’s read', () => {
    /** 20,000 deep outputs, 5 young ones, and 2 of the account's unconfirmed change. */
    function largeAccount(): void {
      fund(20_000, { height: 100 })
      fund(5, { salt: 300, height: explorer.tipHeight - 10 })
      const parent = fakeTxid(1, 400)
      explorer.addTx({
        txid: parent,
        inputs: [{ txid: fakeTxid(2, 400), vout: 0 }],
        outputs: [0, 1].map(() => ({ address, script, value: 30_000 })),
        height: 1_500,
      })
      for (const vout of [0, 1]) {
        explorer.addTx({
          txid: fakeTxid(vout, 401),
          inputs: [{ txid: parent, vout }],
          outputs: [{ address, script, value: 20_000 }],
        })
      }
    }

    it('opens Send for a 20,000-output account with no more lookups than its young and unconfirmed outputs', async () => {
      largeAccount()
      const wallet = new WalletController()

      const snapshot = await wallet.getQbitUtxoSnapshot()

      expect(snapshot.utxos).toHaveLength(20_007)
      // The 5 young outputs, the 2 of change, and the parent their walk reads.
      expect(lookups()).toBe(8)
    })

    it('reads each of them where every funding transaction is read, as Send did before', async () => {
      largeAccount()
      const wallet = new WalletController()

      await wallet.getAddressUtxo(address)

      expect(lookups()).toBe(20_008)
    })
  })

  describe('a send, before it is built', () => {
    it('reads each input it spends, and builds from what it checked', async () => {
      const outputs = fund(3)
      const wallet = new WalletController()

      const toSignData = await send(wallet, provided(outputs))

      const inputs = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).inputs
      expect(lookups()).toBe(inputs.length)
      expect(tipReads()).toBe(1)
      expect(preflight()).toHaveBeenCalledTimes(1)
    })

    it.each([
      [
        'another value',
        'mismatch',
        (outputs: { txid: string }[]) => {
          explorer.txs.get(outputs[0]!.txid)!.outputs[0]!.value = 49_999
        },
      ],
      [
        'another script',
        'mismatch',
        (outputs: { txid: string }[]) => {
          explorer.txs.get(outputs[0]!.txid)!.outputs[0]!.script = otherAccount.p2mr.scriptPubKey
        },
      ],
      [
        'no transaction at the explorer',
        'not_found',
        (outputs: { txid: string }[]) => explorer.removeTx(outputs[0]!.txid),
      ],
      [
        'a lookup the explorer fails',
        'unchecked',
        (outputs: { txid: string }[]) => {
          explorer.failures.push(({ path }) =>
            path === `/tx/${outputs[0]!.txid}` ? { status: 503 } : undefined
          )
        },
      ],
    ])(
      'refuses an input with %s, before any preflight or signature',
      async (_, problem, change) => {
        const outputs = fund(1)
        const wallet = new WalletController()
        change(outputs)

        await expect(send(wallet, provided(outputs))).rejects.toEqual(failedFor(problem))
        await expect(sendAll(wallet, provided(outputs))).rejects.toEqual(failedFor(problem))
        expect(preflight()).not.toHaveBeenCalled()
        expect(signer()).not.toHaveBeenCalled()
      }
    )

    it('refuses an output the page hands back at an index its transaction has no output at', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()

      await expect(send(wallet, provided([{ ...outputs[0]!, vout: 1 }]))).rejects.toEqual(
        failedFor('mismatch')
      )
      expect(preflight()).not.toHaveBeenCalled()
    })

    it('refuses a coinbase output the page hands back before it is mature', async () => {
      const rewards = fund(1, { salt: 7, height: explorer.tipHeight - 10, coinbase: true })
      const wallet = new WalletController()

      await expect(send(wallet, provided(rewards))).rejects.toEqual(failedFor('not_spendable'))
      expect(preflight()).not.toHaveBeenCalled()
    })
  })

  describe('a signing', () => {
    it('reads every input of 106 once before the keyring signs, and the tip once', async () => {
      fund(120)
      const wallet = new WalletController()
      const snapshot = await wallet.getQbitUtxoSnapshot()
      const toSignData = await sendAll(wallet, snapshot.utxos as any)
      const inputs = decodePsbt(parsePsbt(hexToBytes(toSignData.psbtHex))).inputs.length
      expect(inputs).toBe(106)
      const before = { lookups: lookups(), tips: tipReads() }
      let readBeforeSigning = 0
      signer().mockImplementationOnce((async (...args: unknown[]) => {
        readBeforeSigning = lookups() - before.lookups
        const [, { psbt, keys }] = args as [string, { psbt: any; keys: any[] }]
        return {
          psbt: signP2mrPsbt({
            psbt,
            keys,
            sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
          }).psbt,
          signed: [],
          counterResults: [],
        }
      }) as any)

      await wallet.signPsbtV2(toSignData)

      expect(readBeforeSigning).toBe(106)
      expect(lookups() - before.lookups).toBe(106)
      expect(tipReads() - before.tips).toBe(1)
    })

    it('refuses an input a page changed after the build, before the keyring is asked', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))

      await expect(wallet.signPsbtV2(withInputValue(built, 60_000))).rejects.toEqual(
        failedFor('mismatch')
      )
      expect(signer()).not.toHaveBeenCalled()
    })

    it('holds nothing after a failed check: no claim on its inputs, no hold of the auto-lock', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      explorer.txs.get(outputs[0]!.txid)!.outputs[0]!.value = 1

      await expect(wallet.signPsbtV2(built)).rejects.toEqual(failedFor('mismatch'))

      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [
          { txid: outputs[0]!.txid, vout: 0 },
        ])
      ).resolves.toBeUndefined()
      expect((wallet as any).localSignings.size).toBe(0)
      // The same input signs once its transaction reads as the page listed it.
      explorer.txs.get(outputs[0]!.txid)!.outputs[0]!.value = outputs[0]!.satoshis
      await expect(wallet.signPsbtV2(built)).resolves.toMatchObject({ psbtHex: expect.any(String) })
    })

    it('stops a signing whose page closes while its check reads, and leaves nothing behind', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const arrived = holdLookups()

      const signing = wallet.runForUiPort('popup:3', () => wallet.signPsbtV2(built), 'signPsbtV2')
      signing.catch(() => undefined)
      await arrived
      await wallet.onUiPortDisconnected('popup:3')
      releaseLookups()

      await expect(signing).rejects.toMatchObject({ name: 'QbitSigningAbortedError' })
      expect(signer()).not.toHaveBeenCalled()
      expect((wallet as any).localSignings.size).toBe(0)
    })

    it.each([
      [
        'the wallet locks',
        async (wallet: WalletController) => {
          await wallet.lockWallet()
        },
        { code: ErrorCodes.WALLET_LOCKED_DURING_SIGNING },
      ],
      [
        'another account is selected',
        async () => {
          vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)
        },
        { message: 'Qbit account changed since the transaction was created' },
      ],
      [
        'the network changes',
        async () => {
          vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
        },
        { message: 'Qbit network changed since the transaction was created' },
      ],
    ])(
      'reaches neither the preflight nor the keyring when %s while its check reads',
      async (_, during, refusal) => {
        const outputs = fund(1)
        const wallet = new WalletController()
        const built = await send(wallet, provided(outputs))
        preflight().mockClear()
        const arrived = holdLookups()

        const signing = wallet.signPsbtV2(built)
        signing.catch(() => undefined)
        await arrived
        await during(wallet)
        releaseLookups()

        await expect(signing).rejects.toMatchObject(refusal)
        expect(preflight()).not.toHaveBeenCalled()
        expect(signer()).not.toHaveBeenCalled()
      }
    )
  })

  describe('a signing is checked whatever the lock reads, ends its reads with its page, and refuses change handed back as confirmed', () => {
    it('checks a signing asked while the wallet reads locked, and the keyring then refuses it with its own error', async () => {
      const outputs = fund(2)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      lock.isUnlocked = false
      signer().mockRejectedValueOnce(new Error('The wallet is locked'))
      const before = { lookups: lookups(), tips: tipReads() }

      await expect(wallet.signPsbtV2(built)).rejects.toThrow('The wallet is locked')

      const inputs = decodePsbt(parsePsbt(hexToBytes(built.psbtHex))).inputs.length
      expect(lookups() - before.lookups).toBe(inputs)
      expect(tipReads() - before.tips).toBe(1)
    })

    it('refuses bytes a page changed while the wallet reads locked, though the keyring would sign them', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const tampered = withInputValue(built, outputs[0]!.satoshis + 10_000)
      preflight().mockClear()
      // The memory store reads locked while the keyrings are live, as during
      // an unlock before it marks the wallet unlocked: the keyring signs.
      lock.isUnlocked = false

      await expect(wallet.signPsbtV2(tampered)).rejects.toEqual(failedFor('mismatch'))

      expect(preflight()).not.toHaveBeenCalled()
      expect(signer()).not.toHaveBeenCalled()
    })

    it('signs, checked, a signing begun while the wallet read locked once it reads unlocked', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      lock.isUnlocked = false
      const arrived = holdLookups()
      const before = lookups()

      const signing = wallet.signPsbtV2(built)
      signing.catch(() => undefined)
      await arrived
      lock.isUnlocked = true
      releaseLookups()

      await expect(signing).resolves.toMatchObject({ psbtHex: expect.any(String) })
      expect(lookups() - before).toBe(1)
      expect(signer()).toHaveBeenCalledTimes(1)
    })

    it('settles at once with the signing stopped, holding nothing, when its page closes while its lookups never answer', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const arrived = holdLookups()
      const signing = wallet.runForUiPort('popup:4', () => wallet.signPsbtV2(built), 'signPsbtV2')
      signing.catch(() => undefined)
      await arrived

      await wallet.onUiPortDisconnected('popup:4')
      const outcome = await Promise.race([
        signing.then(
          () => 'signed',
          (error: { name?: string }) => error?.name
        ),
        new Promise(resolve => setTimeout(() => resolve('still running after 3 s'), 3_000)),
      ])

      expect(outcome).toBe('QbitSigningAbortedError')
      expect((wallet as any).localSignings.size).toBe(0)
      expect(signer()).not.toHaveBeenCalled()
      releaseLookups()
    })

    it('refuses an unconfirmed change output a page hands back as confirmed, before any preflight', async () => {
      const [parent] = fund(1, { salt: 960, value: 80_000 })
      const child = fakeTxid(1, 961)
      explorer.addTx({
        txid: child,
        inputs: [{ txid: parent!.txid, vout: 0 }],
        outputs: [{ address, script, value: 70_000 }],
      })
      const wallet = new WalletController()

      await expect(
        send(wallet, provided([{ txid: child, vout: 0, satoshis: 70_000 }]), 10_000)
      ).rejects.toEqual(failedFor('mismatch'))
      expect(preflight()).not.toHaveBeenCalled()
    })
  })

  describe('a provider context is no way around the check', () => {
    const providerContext = {
      origin: 'https://dapp.example',
      account: address,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }

    it('checks a wallet send a page marks as a website’s', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))

      await expect(
        wallet.signPsbtV2({ ...withInputValue(built, 60_000), providerContext } as ToSignData)
      ).rejects.toEqual(failedFor('mismatch'))
      expect(signer()).not.toHaveBeenCalled()
    })

    it.each([
      ['null', null],
      ['false', false],
      ['0', 0],
      ['an empty string', ''],
      ['an empty object', {}],
      ['an array', []],
      ['a string', 'claim'],
      ['an object without outpoints', { chain: ChainType.QBIT_REGTEST, address }],
    ])(
      'refuses a send whose page sets the provider claim to %s, before any read, whatever it spends',
      async (_, claim) => {
        const outputs = fund(1)
        const wallet = new WalletController()
        const built = await send(wallet, provided(outputs))
        preflight().mockClear()
        const before = lookups()

        for (const toSignData of [withInputValue(built, 60_000), built]) {
          await expect(
            wallet.signPsbtV2({ ...toSignData, qbitSendBroadcastClaim: claim } as any)
          ).rejects.toThrow('invalid Qbit send broadcast claim')
        }

        expect(lookups()).toBe(before)
        expect(preflight()).not.toHaveBeenCalled()
        expect(signer()).not.toHaveBeenCalled()
      }
    )

    it('refuses a malformed claim before anything is read, even with consolidation details a page added', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const before = explorer.requests.length

      await expect(
        wallet.signPsbtV2({
          ...built,
          qbitConsolidation: { fundingOutputCounts: [1] },
          qbitSendBroadcastClaim: null,
        } as any)
      ).rejects.toThrow('invalid Qbit send broadcast claim')

      expect(explorer.requests.slice(before)).toEqual([])
      expect(signer()).not.toHaveBeenCalled()
    })

    it('checks a provider send whose spent amount a page changed, under its open claim, and signs none of it', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const claim = wallet.createQbitSendBroadcastClaim(built.psbtHex, providerContext as any)
      await wallet.openQbitProviderSendRequest(claim)
      preflight().mockClear()
      const tampered = withInputValue(built, outputs[0]!.satoshis + 10_000)

      await expect(
        wallet.signPsbtV2({ ...tampered, providerContext, qbitSendBroadcastClaim: claim } as any)
      ).rejects.toEqual(failedFor('mismatch'))

      expect(preflight()).not.toHaveBeenCalled()
      expect(signer()).not.toHaveBeenCalled()
    })

    it('signs the exact bytes the wallet built for an open provider send with no lookup, and checks them once its request settles', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const claim = wallet.createQbitSendBroadcastClaim(built.psbtHex, providerContext as any)
      const request = await wallet.openQbitProviderSendRequest(claim)
      const before = lookups()

      await expect(
        wallet.signPsbtV2({ ...built, providerContext, qbitSendBroadcastClaim: claim } as any)
      ).resolves.toMatchObject({ psbtHex: expect.any(String) })
      expect(lookups()).toBe(before)
      expect(signer()).toHaveBeenCalledTimes(1)

      // Settled, the request's bytes skip nothing: they are read and
      // checked, and the guard then refuses the claim no request carries.
      await wallet.settleQbitProviderSendRequest(request, false)
      await expect(
        wallet.signPsbtV2({ ...built, providerContext, qbitSendBroadcastClaim: claim } as any)
      ).rejects.toThrow('provider send request is no longer pending')
      expect(lookups()).toBe(before + 1)
      expect(signer()).toHaveBeenCalledTimes(1)
    })

    it('checks bytes under a provider claim the background minted for no open request', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const tampered = withInputValue(built, 60_000)

      // Minted from these very bytes, but no provider request opened with it:
      // nothing records them, so they are checked, and refused.
      await expect(
        wallet.signPsbtV2({
          ...tampered,
          providerContext,
          qbitSendBroadcastClaim: wallet.createQbitSendBroadcastClaim(
            tampered.psbtHex,
            providerContext as any
          ),
        } as ToSignData)
      ).rejects.toEqual(failedFor('mismatch'))
      expect(signer()).not.toHaveBeenCalled()
    })

    it('skips it only for a website’s admitted bytes, signed with that website’s context, while its approval is open', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const website = await wallet.prepareQbitProviderPsbt(built.psbtHex, {
        chain: ChainType.QBIT_REGTEST,
      } as any)
      /** The lookups one signing of `toSignData` makes, from a guard holding nothing. */
      const lookupsOf = async (toSignData: unknown): Promise<number> => {
        await qbitSendGuardService.resetAllData()
        const before = lookups()
        await wallet.signPsbtV2(toSignData as ToSignData)
        return lookups() - before
      }
      // Not admitted yet (no approval installed): checked.
      expect(await lookupsOf({ ...website, providerContext })).toBe(1)

      website.providerContext = providerContext as any
      const release = wallet.admitQbitWebsitePsbts([website])
      expect(await lookupsOf({ ...website, providerContext })).toBe(0)

      // The same bytes with no provider context, or another website's, and
      // a copy of other bytes: each is read and checked.
      expect(await lookupsOf({ ...website, providerContext: undefined })).toBe(1)
      expect(
        await lookupsOf({
          ...website,
          providerContext: { ...providerContext, origin: 'https://other.example' },
        })
      ).toBe(1)
      await expect(
        wallet.signPsbtV2({ ...withInputValue(website, 60_000), providerContext } as ToSignData)
      ).rejects.toEqual(failedFor('mismatch'))

      // Its approval settled: checked again.
      release()
      expect(await lookupsOf({ ...website, providerContext })).toBe(1)
    })

    /**
     * A website's swap, the account's output and a counterparty's, paid on to
     * the counterparty and back to the account, prepared and admitted as its
     * approval opens; `release` settles that approval.
     */
    async function admittedWebsiteSwap(wallet: WalletController) {
      const [own] = fund(1)
      const leafScript = hexToBytes(account.p2mr.leafScript)
      const counterpartyLeaf = hexToBytes(otherAccount.p2mr.leafScript)
      const counterpartyTxid = fakeTxid(1, 980)
      const swap = createP2mrPsbt({
        inputs: [
          {
            prevout: { txid: hexToBytes(own!.txid).reverse(), vout: own!.vout },
            witnessUtxo: { value: BigInt(own!.satoshis), scriptPubKey: hexToBytes(script) },
            leafScript,
            controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
            merkleRoot: account.leafHash,
          },
          {
            prevout: { txid: hexToBytes(counterpartyTxid).reverse(), vout: 0 },
            witnessUtxo: {
              value: 40_000n,
              scriptPubKey: hexToBytes(otherAccount.p2mr.scriptPubKey),
            },
            leafScript: counterpartyLeaf,
            controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
            merkleRoot: otherAccount.leafHash,
          },
        ],
        outputs: [
          { value: 40_000n, scriptPubKey: hexToBytes(script) },
          {
            value: BigInt(own!.satoshis) - 2_000n,
            scriptPubKey: hexToBytes(otherAccount.p2mr.scriptPubKey),
          },
        ],
      })
      const website = await wallet.prepareQbitProviderPsbt(bytesToHex(serializePsbt(swap)), {
        chain: ChainType.QBIT_REGTEST,
      } as any)
      website.providerContext = providerContext as any
      return { website, release: wallet.admitQbitWebsitePsbts([website]) }
    }

    it('signs a website’s swap left open across a lock and an unlock, the counterparty’s input with it, and checks the same bytes once its approval settles', async () => {
      const wallet = new WalletController()
      const { website, release } = await admittedWebsiteSwap(wallet)

      // The wallet locks while the user reviews it, and is unlocked again.
      await wallet.lockWallet()
      lock.isUnlocked = true
      const before = lookups()
      await expect(
        wallet.signPsbtV2({ ...website, providerContext } as ToSignData)
      ).resolves.toMatchObject({ psbtHex: expect.any(String) })
      expect(lookups()).toBe(before)
      expect(signer()).toHaveBeenCalledTimes(1)

      // Its approval settled: the same bytes are checked, and the
      // counterparty's input is no output of the account.
      release()
      await qbitSendGuardService.resetAllData()
      await expect(
        wallet.signPsbtV2({ ...website, providerContext } as ToSignData)
      ).rejects.toEqual(failedFor('mismatch'))
      expect(signer()).toHaveBeenCalledTimes(1)
    })

    it('signs a website’s swap left open while another wallet is removed, the counterparty’s input with it, and checks the same bytes once its approval settles', async () => {
      const wallet = new WalletController()
      const { website, release } = await admittedWebsiteSwap(wallet)
      // The user removes another wallet, one the swap does not spend from,
      // while its approval is open on the current one.
      const current = {
        type: KeyringType.QbitHdKeyring,
        index: 0,
        key: 'keyring_0',
        accounts: [account],
      }
      const other = {
        type: KeyringType.QbitHdKeyring,
        index: 1,
        key: 'keyring_1',
        accounts: [otherAccount],
      }
      vi.spyOn(wallet as any, 'readKeyringsAfresh')
        .mockResolvedValueOnce([current, other])
        .mockResolvedValueOnce([current])
      vi.spyOn(wallet as any, 'resolveQueuedWalletKeyring').mockReturnValue(other)
      vi.spyOn(wallet as any, 'collectQbitRecoveryRemovalReasons').mockResolvedValue([])
      // It holds no send plan account of its own.
      vi.spyOn(wallet as any, 'qbitSendPlanAccountsOf').mockResolvedValue({
        accounts: [],
        underived: [],
      })
      vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
      const slots = (keyringService as any).keyrings
      slots.push({ type: KeyringType.QbitHdKeyring }, { type: KeyringType.QbitHdKeyring })
      try {
        await wallet.removeKeyring(other as any)
      } finally {
        slots.length = 0
      }
      expect(keyringService.removeKeyring).toHaveBeenCalledWith(1, expect.anything())

      const before = lookups()
      await expect(
        wallet.signPsbtV2({ ...website, providerContext } as ToSignData)
      ).resolves.toMatchObject({ psbtHex: expect.any(String) })
      expect(lookups()).toBe(before)
      expect(signer()).toHaveBeenCalledTimes(1)

      // Its approval settled: the same bytes are checked, and refused.
      release()
      await qbitSendGuardService.resetAllData()
      await expect(
        wallet.signPsbtV2({ ...website, providerContext } as ToSignData)
      ).rejects.toEqual(failedFor('mismatch'))
      expect(signer()).toHaveBeenCalledTimes(1)
    })

    it('admits at most 64 website PSBTs at once and pushes none out: one more is refused', async () => {
      const outputs = fund(1)
      const wallet = new WalletController()
      const built = await send(wallet, provided(outputs))
      const website = await wallet.prepareQbitProviderPsbt(built.psbtHex, {
        chain: ChainType.QBIT_REGTEST,
      } as any)
      website.providerContext = providerContext as any
      wallet.admitQbitWebsitePsbts([website])
      const others = await Promise.all(
        Array.from({ length: 63 }, async (_, index) => {
          const entry = await wallet.prepareQbitProviderPsbt(
            withInputValue(built, outputs[0]!.satoshis + 1 + index).psbtHex,
            { chain: ChainType.QBIT_REGTEST } as any
          )
          entry.providerContext = { ...providerContext, origin: 'https://flood.example' } as any
          return entry
        })
      )
      for (const entry of others) wallet.admitQbitWebsitePsbts([entry])

      expect(() => wallet.admitQbitWebsitePsbts([others[0]!])).toThrow(
        'Too many website signing requests are open'
      )
      // The first website's PSBT still skips the check.
      const before = lookups()
      await wallet.signPsbtV2({ ...website, providerContext } as ToSignData)
      expect(lookups()).toBe(before)
    })

    it('offers pages no way to prepare a website’s PSBT or open a provider request', () => {
      expect(UI_CONTROLLER_METHODS).not.toContain('prepareQbitProviderPsbt')
      expect(UI_CONTROLLER_METHODS).not.toContain('openQbitProviderSendRequest')
    })
  })

  describe('what let a signing skip the check holds still as the keyring is called', () => {
    const providerContext = {
      origin: 'https://dapp.example',
      account: address,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }

    /**
     * A signing that skips the check, of a send the wallet built: a website's
     * PSBT its approval admitted, or a provider send whose request is open.
     * `extra` is what the page adds to the bytes it hands over; `settle` ends
     * the approval or the request (the guard's own close of the request
     * queues behind whatever its queue holds).
     */
    async function skippingSigning(
      wallet: WalletController,
      kind: 'website' | 'provider send'
    ): Promise<{
      sign: (extra: Record<string, unknown>) => Promise<unknown>
      settle: () => Promise<void>
      inputs: number
    }> {
      const built = await send(wallet, provided(fund(1)))
      const inputs = decodePsbt(parsePsbt(hexToBytes(built.psbtHex))).inputs.length
      if (kind === 'website') {
        const website = await wallet.prepareQbitProviderPsbt(built.psbtHex, {
          chain: ChainType.QBIT_REGTEST,
        } as any)
        website.providerContext = providerContext as any
        const release = wallet.admitQbitWebsitePsbts([website])
        return {
          sign: extra => wallet.signPsbtV2({ ...website, providerContext, ...extra } as ToSignData),
          settle: async () => release(),
          inputs,
        }
      }
      const claim = wallet.createQbitSendBroadcastClaim(built.psbtHex, providerContext as any)
      const request = await wallet.openQbitProviderSendRequest(claim)
      return {
        sign: extra =>
          wallet.signPsbtV2({
            ...built,
            providerContext,
            qbitSendBroadcastClaim: claim,
            ...extra,
          } as ToSignData),
        settle: () => wallet.settleQbitProviderSendRequest(request, false),
        inputs,
      }
    }

    /** Hold every read of the outputs that spend a transaction's outputs until `release`; `arrived` once one has. */
    function holdOutspends() {
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      let arrive: () => void = () => undefined
      const arrived = new Promise<void>(resolve => (arrive = resolve))
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input : input.url
        )
        if (url.pathname.endsWith('/outspends')) {
          arrive()
          await released
        }
        return fetchFn(input, init)
      })
      return { arrived, release }
    }

    /** Hold the send guard's queue: every step of it asked for from now on waits until `release`. */
    function holdGuardQueue() {
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      const held = qbitSendGuardService.runWithNoOverlap(
        ChainType.QBIT_REGTEST,
        [{ txid: fakeTxid(1, 990), vout: 0 }],
        async () => {
          await released
        }
      )
      return { held, release }
    }

    const refusals = {
      website: 'Qbit website signing request is no longer pending',
      'provider send': 'Qbit provider send request is no longer pending',
    }

    /**
     * What each case asserts, by kind and by where the signing waits. A
     * provider send whose request settles while it waits on the reads is
     * refused by the send guard itself, which closes the request before the
     * signing joins its queue, in the same words as the test again: no such
     * case can show that test, so only the one that stays open is kept.
     */
    const cases: Record<
      'website' | 'provider send',
      Record<'reads' | 'queue', [string, boolean][]>
    > = {
      website: {
        reads: [
          ['signs while its approval stays open', false],
          [
            'is refused, unsigned, by the test of its admission once its approval has settled',
            true,
          ],
        ],
        queue: [
          ['signs while its approval stays open', false],
          [
            'is refused, unsigned, by the test of its admission once its approval has settled',
            true,
          ],
        ],
      },
      'provider send': {
        reads: [['signs while its request stays open', false]],
        queue: [
          ['signs while its request stays open', false],
          [
            'is refused, unsigned, by the test of its recorded bytes once its request has settled, while the guard still holds that request open',
            true,
          ],
        ],
      },
    }

    describe.each(['website', 'provider send'] as const)('for a %s', kind => {
      it.each(cases[kind].reads)(
        'waits on a consolidation’s reads a page added, then %s',
        async (_, settles) => {
          const wallet = new WalletController()
          const { sign, settle, inputs } = await skippingSigning(wallet, kind)
          const outspends = holdOutspends()
          const before = lookups()

          const signing = sign({
            qbitConsolidation: { fundingOutputCounts: Array.from({ length: inputs }, () => 1) },
          })
          signing.catch(() => undefined)
          await outspends.arrived
          if (settles) await settle()
          outspends.release()

          if (settles) {
            await expect(signing).rejects.toThrow(refusals[kind])
            expect(signer()).not.toHaveBeenCalled()
          } else {
            await expect(signing).resolves.toMatchObject({ psbtHex: expect.any(String) })
            expect(signer()).toHaveBeenCalledTimes(1)
          }
          // Skipped or refused, it read no funding transaction.
          expect(lookups()).toBe(before)
        }
      )

      it.each(cases[kind].queue)('waits in the send guard’s queue, then %s', async (_, settles) => {
        const wallet = new WalletController()
        const { sign, settle } = await skippingSigning(wallet, kind)
        const queue = holdGuardQueue()
        const asked = [
          vi.spyOn(qbitSendGuardService, 'runWithNoOverlap'),
          vi.spyOn(qbitSendGuardService, 'runWithProviderBroadcastClaim'),
        ]
        try {
          const before = lookups()

          const signing = sign({})
          signing.catch(() => undefined)
          // In the queue, behind what holds it.
          await vi.waitFor(() => expect(asked.some(spy => spy.mock.calls.length > 0)).toBe(true))
          // A request's settling queues the guard's own close behind the
          // signing: only the background's record of the bytes is gone.
          const settled = settles ? settle() : undefined
          queue.release()
          await queue.held

          if (settles) {
            await expect(signing).rejects.toThrow(refusals[kind])
            expect(signer()).not.toHaveBeenCalled()
          } else {
            await expect(signing).resolves.toMatchObject({ psbtHex: expect.any(String) })
            expect(signer()).toHaveBeenCalledTimes(1)
          }
          await settled
          expect(lookups()).toBe(before)
        } finally {
          queue.release()
          for (const spy of asked) spy.mockRestore()
        }
      })
    })
  })
})
