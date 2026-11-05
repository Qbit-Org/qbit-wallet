import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrLeafHash,
  parsePsbt,
  serializePsbt,
} from '@qbit-oss/protocol'
import type { KeyringService } from '@qbit/keyring-service'
import { QbitHdKeyring } from '@qbit/keyring-service/qbit-hd-keyring'
import { ErrorCodes, type ToSignData } from '@qbit/wallet-shared'
import { WalletController } from '../src/controllers/wallet'
import { keyringService as realKeyringService } from '../src/services'

// The real KeyringService, with its batch store, counter and restored-floor
// challenges, behind the real WalletController; only the services around
// them are stand-ins.
vi.mock('../src/services', async () => {
  const { KeyringService } = await import('@qbit/keyring-service')
  const { ChainType } = await import('@qbit/wallet-types')
  return {
    keyringService: new KeyringService(),
    preferenceService: {
      getCurrentAccount: vi.fn(() => undefined),
      getAddressFlag: vi.fn(() => 0),
      getAccountAlianName: vi.fn((_key: string, name: string) => name),
      getKeyringAlianName: vi.fn((_key: string, name: string) => name),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getCurrentKeyringIndex: vi.fn(() => 0),
    },
    qbitSendGuardService: {
      runWithNoOverlap: vi.fn(
        async (_chain: unknown, _outpoints: unknown, operation: () => Promise<unknown>) =>
          operation()
      ),
    },
    walletApiService: {},
    sessionService: {},
    contactBookService: {},
    notificationService: {},
    permissionService: {},
  }
})

vi.mock('../src/services/approval', () => ({
  default: {},
}))

const keyringService = realKeyringService as unknown as KeyringService

const SOURCE_MNEMONIC =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const HD_PATH = "m/87'/1'/0'/0"
const PASSWORD = 'password'
const QBIT_P2MR_RBF_SEQUENCE = 0xfffffffd
const PQC_SIGNATURE_BYTES = 3680
const FEE = 2_000

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    const stored = (await this.get(name)) || template
    await this.set(name, stored)
    return stored
  }
}

class JsonEncryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

let txidSeed = 1

/** A plan sweeping `inputCount` outputs of `account` to `destinationAddress`'s script. */
function migrationPlan(
  account: { pubkey: string; leafScript: string; scriptPubKey: string; address: string },
  destination: { address: string; scriptPubKey: string },
  planIndex: number,
  inputCount = 1
) {
  const leafScript = hexToBytes(account.leafScript)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const values = Array.from({ length: inputCount }, (_value, index) => 50_000n + BigInt(index))
  const total = values.reduce((sum, value) => sum + value, 0n)
  const psbt = createP2mrPsbt({
    inputs: values.map(value => {
      const txid = new Uint8Array(32).fill(0)
      txid[0] = txidSeed & 0xff
      txid[1] = (txidSeed >> 8) & 0xff
      txidSeed += 1
      return {
        prevout: { txid, vout: 0 },
        witnessUtxo: { value, scriptPubKey: hexToBytes(account.scriptPubKey) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
        sequence: QBIT_P2MR_RBF_SEQUENCE,
      }
    }),
    outputs: [{ value: total - BigInt(FEE), scriptPubKey: hexToBytes(destination.scriptPubKey) }],
  })
  return {
    id: `${account.pubkey}:${planIndex}`,
    sourcePubkey: account.pubkey,
    sourceAddress: account.address,
    destinationAddress: destination.address,
    amount: Number(total) - FEE,
    fee: FEE,
    psbtHex: bytesToHex(serializePsbt(psbt)),
    status: 'prepared' as const,
  }
}

/**
 * A wallet restored from a seed, migrating its `sources` accounts to a fresh
 * wallet: each account `i` holds `plansPerSource[i]` reviewed plans.
 */
async function migratingWallet(plansPerSource: number[], inputCount = 1) {
  const storage = new MemoryStorage()
  await keyringService.init({
    storage,
    encryptor: new JsonEncryptor(),
    logger: quietLogger,
    t: (key: string) => key,
  } as any)
  await keyringService.boot(PASSWORD)
  const source = keyringService.createTmpKeyring(QbitHdKeyring.type, {
    mnemonic: SOURCE_MNEMONIC,
    activeIndexes: [0],
    hdPath: HD_PATH,
  }) as QbitHdKeyring
  await keyringService.addDiscoveredQbitKeyring(source, plansPerSource.length, true, 'regtest')
  const sourceAccounts = (await source.getQbitAccounts()).slice(0, plansPerSource.length)
  for (const account of sourceAccounts) {
    await keyringService.restorePqcSignatureCounterFloors(
      account.pubkey,
      () => ({ observedSignatures: 3 }),
      { lookahead: 0 }
    )
  }
  const destinationMnemonic = await keyringService.generatePreMnemonic()
  const { destinationAddress } = await keyringService.createQbitMigrationKeyring({
    sourceAddress: sourceAccounts[0]!.pubkey,
    mnemonic: destinationMnemonic,
    hdPath: HD_PATH,
    passphrase: '',
    network: 'regtest',
  })
  const destinationRaw = keyringService.keyrings[1] as QbitHdKeyring
  const [destinationAccount] = await destinationRaw.getQbitAccounts()
  const destination = {
    address: destinationAddress,
    scriptPubKey: destinationAccount!.scriptPubKey,
  }
  const plans = sourceAccounts.flatMap((account, sourceIndex) =>
    Array.from({ length: plansPerSource[sourceIndex]! }, (_value, planIndex) =>
      migrationPlan(
        { ...account, address: account.addresses.regtest },
        destination,
        planIndex,
        inputCount
      )
    )
  )
  await keyringService.replaceQbitRecoveryMigrationPlans(
    sourceAccounts[0]!.pubkey,
    'regtest',
    plans
  )
  stubPqcSigning()
  return { storage, sourceAccounts, plans }
}

/** SLH-DSA signing is slow; the counter and cache it goes through stay real. */
function stubPqcSigning() {
  const source = keyringService.keyrings[0] as QbitHdKeyring
  vi.spyOn(source, 'signPqcDigest').mockImplementation(async () =>
    new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)
  )
}

async function counterOf(pubkey: string) {
  return keyringService.getPqcSignatureCounter(pubkey)
}

async function planStatuses(anchorPubkey: string) {
  const state = await keyringService.getQbitRecoveryState(anchorPubkey, 'regtest')
  return state.migration!.plans.map(plan => plan.status)
}

function openBatchIds(): string[] {
  return [...(keyringService as any).qbitPqcSignatureBatches.keys()]
}

function batchIdsOf(toSignDatas: ToSignData[]): (string | undefined)[] {
  return toSignDatas.map(toSignData => toSignData.qbitSignatureBatch?.id)
}

function challengeOf(toSignData: ToSignData): string {
  return toSignData.signatureBudget!.restoredFloorRisk!.challengeId
}

function signingInputOf(account: { pubkey: string; leafScript: string }, psbtHex: string) {
  const psbt = parsePsbt(hexToBytes(psbtHex))
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, hexToBytes(account.leafScript))
  const keys = decodePsbt(psbt).inputs.map((_input, inputIndex) => ({
    inputIndex,
    pubkey: hexToBytes(account.pubkey),
    leafHash,
  }))
  return { psbt, keys }
}

/** Open `count` website requests' batches of two PSBTs each, from an account of the fresh wallet. */
async function openWebsiteBatches(count: number) {
  const [website] = await (keyringService.keyrings[1] as QbitHdKeyring).getQbitAccounts()
  const websiteAccount = { ...website!, address: website!.addresses.regtest }
  const requests = await Promise.all(
    Array.from({ length: count }, async (_value, request) =>
      Promise.all(
        [0, 1].map(async entry => {
          const input = signingInputOf(
            websiteAccount,
            migrationPlan(websiteAccount, websiteAccount, request * 2 + entry).psbtHex
          )
          return {
            ...input,
            approvedBudget: await keyringService.preflightP2mrPsbtSigning(
              websiteAccount.pubkey,
              input
            ),
          }
        })
      )
    )
  )
  return Promise.allSettled(
    requests.map(inputs => keyringService.openP2mrPsbtSigningBatch(websiteAccount.pubkey, inputs))
  )
}

/** What the screen's sign button does: confirm each plan's challenge, then sign it. */
async function signReviewed(wallet: WalletController, toSignDatas: ToSignData[]) {
  for (const toSignData of toSignDatas) {
    await wallet.confirmQbitRestoredFloorSigning(
      toSignData.signatureBudget!.restoredFloorRisk!.challengeId
    )
    await wallet.signPsbtV2(toSignData)
  }
}

describe('recovery migration signs every reviewed plan in one press (#156)', () => {
  beforeAll(async () => {
    await init()
  })

  beforeEach(() => {
    txidSeed = 1
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await keyringService.setLocked()
  })

  it('signs two different plans from one source', async () => {
    const { sourceAccounts } = await migratingWallet([2])
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey
    const counterBefore = await counterOf(pubkey)

    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    expect(prepared.toSignDatas).toHaveLength(2)
    await signReviewed(wallet, prepared.toSignDatas)

    expect(await planStatuses(pubkey)).toEqual(['signed', 'signed'])
    expect(await counterOf(pubkey)).toBe(counterBefore + 2)
    // Nothing is left to sign from it, with or without its review's release.
    expect(openBatchIds()).toEqual([])
  })

  it('signs three plans from one source as one batch, and refuses a plan signed twice', async () => {
    const { sourceAccounts } = await migratingWallet([3], 2)
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey
    const counterBefore = await counterOf(pubkey)

    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    const [batchId] = batchIdsOf(prepared.toSignDatas)
    expect(batchIdsOf(prepared.toSignDatas)).toEqual([batchId, batchId, batchId])
    expect(prepared.toSignDatas.map(data => data.qbitSignatureBatch?.index)).toEqual([0, 1, 2])
    expect(prepared.toSignDatas[0]!.qbitSignatureBatch!.budget).toMatchObject({ required: 6 })
    await signReviewed(wallet, prepared.toSignDatas)

    expect(await planStatuses(pubkey)).toEqual(['signed', 'signed', 'signed'])
    expect(await counterOf(pubkey)).toBe(counterBefore + 6)
    await expect(wallet.signPsbtV2(prepared.toSignDatas[1]!)).rejects.toThrow(
      'Qbit recovery migration signing data changed after review'
    )
    expect(await counterOf(pubkey)).toBe(counterBefore + 6)
  })

  it('signs the plans of two sources, one batch for each key, and none across them', async () => {
    const { sourceAccounts } = await migratingWallet([2, 2])
    const wallet = new WalletController()
    const [first, second] = sourceAccounts.map(account => account.pubkey)
    const counters = [await counterOf(first!), await counterOf(second!)]

    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    const ids = batchIdsOf(prepared.toSignDatas)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).toBe(ids[3])
    expect(ids[0]).not.toBe(ids[2])
    expect(openBatchIds().sort()).toEqual([ids[0], ids[2]].sort())

    // A plan of one key named as an entry of the other key's batch is refused.
    const crossed = {
      ...prepared.toSignDatas[2]!,
      qbitSignatureBatch: prepared.toSignDatas[0]!.qbitSignatureBatch,
    }
    await wallet.confirmQbitRestoredFloorSigning(challengeOf(crossed))
    await expect(wallet.signPsbtV2(crossed)).rejects.toThrow(
      'P2MR signature batch belongs to another account'
    )

    await signReviewed(wallet, prepared.toSignDatas)
    expect(await planStatuses(first!)).toEqual(['signed', 'signed', 'signed', 'signed'])
    expect([await counterOf(first!), await counterOf(second!)]).toEqual([
      counters[0]! + 2,
      counters[1]! + 2,
    ])
  })

  it('opens no batch for a source with one plan', async () => {
    await migratingWallet([1, 2])
    const wallet = new WalletController()

    const prepared = await wallet.prepareQbitRecoveryMigration(0)

    expect(prepared.toSignDatas[0]!.qbitSignatureBatch).toBeUndefined()
    expect(openBatchIds()).toEqual([prepared.toSignDatas[1]!.qbitSignatureBatch!.id])
    await signReviewed(wallet, prepared.toSignDatas)
  })

  it('refuses the next plan once a signature is made elsewhere between plans', async () => {
    const { sourceAccounts } = await migratingWallet([2])
    const wallet = new WalletController()
    const account = sourceAccounts[0]!
    const counterBefore = await counterOf(account.pubkey)
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    await signReviewed(wallet, prepared.toSignDatas.slice(0, 1))

    // A transfer of protected assets is the other signing a migrating key does.
    const elsewhere = signingInputOf(
      account,
      migrationPlan(
        { ...account, address: account.addresses.regtest },
        { address: account.addresses.regtest, scriptPubKey: account.scriptPubKey },
        9
      ).psbtHex
    )
    const elsewhereBudget = await keyringService.preflightP2mrPsbtSigning(
      account.pubkey,
      elsewhere,
      { allowMigrationProtectedAssetTransfer: true }
    )
    await keyringService.confirmQbitRestoredFloorSigning(
      elsewhereBudget.restoredFloorRisk!.challengeId
    )
    await keyringService.signP2mrPsbtWithCounter(account.pubkey, elsewhere, elsewhereBudget)

    await wallet.confirmQbitRestoredFloorSigning(challengeOf(prepared.toSignDatas[1]!))
    await expect(wallet.signPsbtV2(prepared.toSignDatas[1]!)).rejects.toThrow(
      'P2MR signature budget changed after approval'
    )
    expect(await planStatuses(account.pubkey)).toEqual(['signed', 'prepared'])
    expect(await counterOf(account.pubkey)).toBe(counterBefore + 2)

    // The screen prepares the plan left again, with the budget that now holds.
    const again = await wallet.prepareQbitRecoveryMigration(0)
    await signReviewed(wallet, again.toSignDatas)
    expect(await planStatuses(account.pubkey)).toEqual(['signed', 'signed'])
  })

  it('asks each plan for its own confirmation, and keeps the batch through each one', async () => {
    const { sourceAccounts } = await migratingWallet([3])
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    const [batchId] = batchIdsOf(prepared.toSignDatas)
    expect(new Set(prepared.toSignDatas.map(challengeOf)).size).toBe(3)

    for (const toSignData of prepared.toSignDatas) {
      // Unconfirmed, the plan is refused before anything is signed, and its
      // batch stays open; a plan confirmed before it confirmed only itself.
      const counter = await counterOf(pubkey)
      await expect(wallet.signPsbtV2(toSignData)).rejects.toThrow(
        'qbit_recovery_signing_confirmation_required'
      )
      expect(await counterOf(pubkey)).toBe(counter)
      await wallet.confirmQbitRestoredFloorSigning(challengeOf(toSignData))
      expect(keyringService.hasOpenP2mrPsbtSigningBatches([batchId!])).toBe(true)
      // Signing consumes the plan's challenge, which leaves the batch open
      // for the plans after it.
      await wallet.signPsbtV2(toSignData)
      expect(keyringService.hasOpenP2mrPsbtSigningBatches([batchId!])).toBe(
        toSignData !== prepared.toSignDatas[2]
      )
    }
    expect(await planStatuses(pubkey)).toEqual(['signed', 'signed', 'signed'])
  })

  it('reopens the same batch on each poll, and leaves one being signed alone', async () => {
    const { sourceAccounts } = await migratingWallet([3])
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey

    const review = await wallet.prepareQbitRecoveryMigration(0)
    for (let poll = 0; poll < 70; poll += 1) {
      const again = await wallet.prepareQbitRecoveryMigration(0)
      expect(batchIdsOf(again.toSignDatas)).toEqual(batchIdsOf(review.toSignDatas))
    }
    expect(openBatchIds()).toEqual([review.toSignDatas[0]!.qbitSignatureBatch!.id])

    // A poll while the review is being signed prepares the plans left with
    // the budgets that hold now, in a batch of their own.
    await signReviewed(wallet, review.toSignDatas.slice(0, 1))
    const during = await wallet.prepareQbitRecoveryMigration(0)
    expect(during.toSignDatas.map(data => data.qbitRecoveryMigration!.planId)).toEqual(
      review.toSignDatas.slice(1).map(data => data.qbitRecoveryMigration!.planId)
    )
    expect(during.toSignDatas[0]!.qbitSignatureBatch!.id).not.toBe(
      review.toSignDatas[0]!.qbitSignatureBatch!.id
    )
    expect(openBatchIds()).toHaveLength(2)

    await signReviewed(wallet, review.toSignDatas.slice(1))
    expect(await planStatuses(pubkey)).toEqual(['signed', 'signed', 'signed'])
    // Every plan of both batches signed, so neither has anything left to sign.
    expect(openBatchIds()).toEqual([])
  })

  it('closes the batch when its review ends, and refuses its plans as interrupted', async () => {
    const { sourceAccounts } = await migratingWallet([2])
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    const counter = await counterOf(pubkey)

    // The screen releases the challenges of a review it leaves.
    wallet.releaseQbitRestoredFloorSigningChallenges(prepared.toSignDatas.map(challengeOf))

    expect(openBatchIds()).toEqual([])
    await expect(wallet.signPsbtV2(prepared.toSignDatas[0]!)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REVIEW_INTERRUPTED,
      message: 'qbit_recovery_review_interrupted',
    })
    expect(await counterOf(pubkey)).toBe(counter)
  })

  it('signs no plan on the batch a lock closed, and signs the rest once prepared again', async () => {
    const { sourceAccounts } = await migratingWallet([3])
    const wallet = new WalletController()
    const pubkey = sourceAccounts[0]!.pubkey
    const review = await wallet.prepareQbitRecoveryMigration(0)
    await signReviewed(wallet, review.toSignDatas.slice(0, 1))

    await keyringService.setLocked()
    await keyringService.submitPassword(PASSWORD)
    stubPqcSigning()
    const counter = await counterOf(pubkey)

    await expect(
      wallet.confirmQbitRestoredFloorSigning(challengeOf(review.toSignDatas[1]!))
    ).rejects.toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await expect(wallet.signPsbtV2(review.toSignDatas[1]!)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REVIEW_INTERRUPTED,
    })
    expect(await counterOf(pubkey)).toBe(counter)
    expect(await planStatuses(pubkey)).toEqual(['signed', 'prepared', 'prepared'])

    const again = await wallet.prepareQbitRecoveryMigration(0)
    expect(again.toSignDatas).toHaveLength(2)
    await signReviewed(wallet, again.toSignDatas)
    expect(await planStatuses(pubkey)).toEqual(['signed', 'signed', 'signed'])
  })

  it('refuses a confirmed plan whose challenge expired before it signed, as at confirmation', async () => {
    const { sourceAccounts } = await migratingWallet([1, 2])
    const wallet = new WalletController()
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    // The plan of the source with one plan, and the first of the other's batch.
    const plans = prepared.toSignDatas.slice(0, 2)
    expect(plans.map(plan => plan.qbitSignatureBatch === undefined)).toEqual([true, false])
    const counters = await Promise.all(sourceAccounts.map(account => counterOf(account.pubkey)))
    for (const plan of plans) {
      await wallet.confirmQbitRestoredFloorSigning(challengeOf(plan))
    }

    // Each challenge expires between its plan's confirmation and its signing.
    // The batch is still open, so the keyring refuses the plan with the code
    // its confirmation would have failed with.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000)
    expect(keyringService.hasOpenP2mrPsbtSigningBatches([plans[1]!.qbitSignatureBatch!.id])).toBe(
      true
    )
    for (const plan of plans) {
      await expect(wallet.signPsbtV2(plan)).rejects.toMatchObject({
        code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED',
      })
    }
    expect(await Promise.all(sourceAccounts.map(account => counterOf(account.pubkey)))).toEqual(
      counters
    )
    expect(await planStatuses(sourceAccounts[0]!.pubkey)).toEqual([
      'prepared',
      'prepared',
      'prepared',
    ])
  })

  it('keeps the batch of a review through a burst of website requests', async () => {
    const { sourceAccounts } = await migratingWallet([2])
    const wallet = new WalletController()
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    const [migrationBatchId] = batchIdsOf(prepared.toSignDatas)

    // 64 requests of two PSBTs each open their batches at once.
    const opened = await openWebsiteBatches(64)

    expect(opened.filter(result => result.status === 'fulfilled')).toHaveLength(63)
    expect(
      opened
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason.message)
    ).toEqual([
      'Too many signing requests are waiting; finish or reject one before sending another',
    ])
    expect(keyringService.hasOpenP2mrPsbtSigningBatches([migrationBatchId!])).toBe(true)

    await signReviewed(wallet, prepared.toSignDatas)
    expect(await planStatuses(sourceAccounts[0]!.pubkey)).toEqual(['signed', 'signed'])
  })

  it('leaves the batch it only reopened when a preparation cannot open them all', async () => {
    const { sourceAccounts } = await migratingWallet([2, 3])
    const wallet = new WalletController()
    // Review X signs one plan of the second source.
    const review = await wallet.prepareQbitRecoveryMigration(0)
    const [firstPlans, secondPlans] = [review.toSignDatas.slice(0, 2), review.toSignDatas.slice(2)]
    await signReviewed(wallet, secondPlans.slice(0, 1))
    const websiteBatches = await openWebsiteBatches(62)
    expect(websiteBatches.every(result => result.status === 'fulfilled')).toBe(true)

    // Review Y reopens X's batch of the first source, and finds no room for
    // one of the second source's plans left.
    await expect(wallet.prepareQbitRecoveryMigration(0)).rejects.toThrow(
      'Too many signing requests are waiting'
    )
    expect(
      keyringService.hasOpenP2mrPsbtSigningBatches([
        firstPlans[0]!.qbitSignatureBatch!.id,
        secondPlans[0]!.qbitSignatureBatch!.id,
      ])
    ).toBe(true)

    // X signs the rest of its review.
    await signReviewed(wallet, [...firstPlans, ...secondPlans.slice(1)])
    expect(await planStatuses(sourceAccounts[0]!.pubkey)).toEqual(Array(5).fill('signed'))
  })

  it('closes the batches it opened when a preparation cannot open them all', async () => {
    await migratingWallet([2, 2])
    const wallet = new WalletController()
    const websiteBatches = await openWebsiteBatches(63)
    expect(websiteBatches.every(result => result.status === 'fulfilled')).toBe(true)
    const before = openBatchIds()

    // The first source's batch takes the last room, and the second's is refused.
    await expect(wallet.prepareQbitRecoveryMigration(0)).rejects.toThrow(
      'Too many signing requests are waiting'
    )
    expect(openBatchIds()).toEqual(before)

    // Once a request settles there is room for both again.
    keyringService.releaseP2mrPsbtSigningBatches(before.slice(0, 1))
    const prepared = await wallet.prepareQbitRecoveryMigration(0)
    await signReviewed(wallet, prepared.toSignDatas)
  })
})
