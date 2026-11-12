import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { PQC_SIGNATURE_BYTES } from '@qbit-oss/protocol'
import type { KeyringService } from '@qbit/keyring-service'
import { QbitHdKeyring } from '@qbit/keyring-service/qbit-hd-keyring'
import { AddressType } from '@qbit/wallet-types'

import { keyringService as realKeyringService, preferenceService } from '../src/services'
import {
  CHAIN,
  T0,
  World,
  newPlanGuard,
  p2mrAccount,
  watchPlanAnnouncements,
  type QbitSendPlanAccount,
} from './qbit-send-plan-engine-harness'

// A send plan signed by the real KeyringService (#188): its counter, its
// signature batches and its per-key signature cache, which keeps a key's
// 16 most recent signatures. Only SLH-DSA itself is a stand-in, since it is
// slow; everything it goes through is real. The explorer is the harness's
// fake, served over fetch.

const guardHolder = vi.hoisted(() => ({ guard: undefined as unknown as object }))
vi.mock('../src/services', async () => {
  const { KeyringService } = await import('@qbit/keyring-service')
  const { ChainType } = await import('@qbit/wallet-types')
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  guardHolder.guard = new QbitSendGuardService()
  const guard = new Proxy(
    {},
    {
      get: (_target, property) => {
        const value = (guardHolder.guard as Record<PropertyKey, unknown>)[property]
        return typeof value === 'function' ? value.bind(guardHolder.guard) : value
      },
    }
  )
  return {
    keyringService: new KeyringService(),
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 0),
      getInitAlianNameStatus: vi.fn(() => true),
      getLockOnComputerLock: vi.fn(() => true),
      getLockOnWindowsClosed: vi.fn(() => true),
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn() },
    contactBookService: { listAlias: vi.fn(() => []) },
    permissionService: {},
  }
})
vi.mock('../src/services/approval', () => ({ default: {} }))

const keyringService = realKeyringService as unknown as KeyringService

const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const HD_PATH = "m/87'/1'/0'/0"
const PASSWORD = 'password'

class VaultStorage {
  readonly values = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    const stored = ((await this.get(name)) as T | undefined) ?? template
    await this.set(name, stored)
    return stored
  }
}

class JsonEncryptor {
  async encrypt(password: string, data: unknown): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<unknown> {
    const parsed = JSON.parse(encryptedData) as { password: string; data: unknown }
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Signatures made so far, and what runs before the next one is made. */
const signer = { calls: 0, before: undefined as ((call: number) => void) | undefined }

/** The live keyring signs with placeholder signatures; a keyring an unlock loads again too. */
function stubSignatures(): void {
  const keyring = keyringService.keyrings[0] as QbitHdKeyring
  vi.spyOn(keyring, 'signPqcDigest').mockImplementation(async () => {
    signer.calls += 1
    signer.before?.(signer.calls)
    return new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)
  })
}

/** A fresh wallet whose one account the real keyring holds; its signature counter starts at 0. */
async function realAccount(): Promise<QbitSendPlanAccount> {
  await keyringService.init({
    storage: new VaultStorage(),
    encryptor: new JsonEncryptor(),
    logger: quietLogger,
    t: (key: string) => key,
  } as never)
  await keyringService.boot(PASSWORD)
  await keyringService.createKeyringWithMnemonics(MNEMONIC, HD_PATH, '', AddressType.P2MR, 1)
  const [held] = await (keyringService.keyrings[0] as QbitHdKeyring).getQbitAccounts()
  stubSignatures()
  return p2mrAccount(held!.pubkey)
}

async function counter(owner: QbitSendPlanAccount): Promise<number> {
  return keyringService.getPqcSignatureCounter(owner.pubkey)
}

let world: World

beforeAll(async () => {
  await init()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  signer.calls = 0
  signer.before = undefined
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
})

afterEach(async () => {
  world?.assertGuarantees()
  world?.engine.reset()
  await keyringService.setLocked()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a send plan signed by the real keyring', () => {
  it('goes on by itself after a lock and an unlock in the middle of a merge, the merge signed again in full', async () => {
    const owner = await realAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(owner as never)
    newPlanGuard(guardHolder)
    world = new World({ isUnlocked: true }, () => newPlanGuard(guardHolder), owner)
    watchPlanAnnouncements(() => world)
    world.fund(110, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    // One merge of 106 inputs and a payment of five.
    expect(review.merges).toHaveLength(1)
    expect(review.signatureCount).toBe(111)
    expect(review.signatureBudget).toMatchObject({ required: 111, remainingBefore: 1_073_741_824 })

    // The lock comes while the 41st signature is made: the keyring has
    // taken its unit, and keeps it, but never hands the signature out.
    signer.before = call => {
      if (call === 41) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    signer.before = undefined
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })

    await keyringService.submitPassword(PASSWORD)
    expect(await counter(owner)).toBe(41)
    stubSignatures()
    world.engine.onUnlock()
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    // The cache kept the last 16 of the 40 signatures made, and signing
    // the merge again from its first input evicted them first: all 106
    // again, then the payment's five.
    expect(await counter(owner)).toBe(41 + 111)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('waits for continue when something else signed with the key while the plan was stopped', async () => {
    const owner = await realAccount()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(owner as never)
    newPlanGuard(guardHolder)
    world = new World({ isUnlocked: true }, () => newPlanGuard(guardHolder), owner)
    watchPlanAnnouncements(() => world)
    world.fund(110, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    signer.before = call => {
      if (call === 41) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    signer.before = undefined

    await keyringService.submitPassword(PASSWORD)
    stubSignatures()
    // Two signatures of another request, before the plan goes on.
    for (const digest of ['a1', 'b2']) {
      await keyringService.signPqcDigestWithCounter(owner.pubkey, digest.repeat(32), async () =>
        new Uint8Array(PQC_SIGNATURE_BYTES).fill(9)
      )
    }
    world.engine.onUnlock()
    await world.settle()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: {
        reason: 'interrupted',
        detail: 'The signature budget changed since the plan was approved',
      },
      actions: ['continue', 'cancel'],
    })
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(await counter(owner)).toBe(41 + 2 + 111)
  })
})
