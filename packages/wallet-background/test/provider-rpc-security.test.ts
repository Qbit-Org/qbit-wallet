import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCodes, WalletError } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

const providerControllerMock = vi.hoisted(() => ({
  pushPsbt: vi.fn(),
  pushTx: vi.fn(),
  requestAccounts: vi.fn(),
  sendQbit: vi.fn(),
  signMessage: vi.fn(),
  signPsbt: vi.fn(),
  signPsbts: vi.fn(),
}))
const approvalServiceMock = vi.hoisted(() => ({
  rejectApproval: vi.fn(),
  requestApproval: vi.fn(),
  unLock: vi.fn(),
}))
const permissionState = vi.hoisted(() => ({ allowed: true }))
const permissionServiceMock = vi.hoisted(() => ({
  addConnectedSite: vi.fn(),
  hasPermission: vi.fn(() => permissionState.allowed),
  touchConnectedSite: vi.fn(),
  updateConnectSite: vi.fn(),
}))
// The keyring's lock listeners, kept across tests as rpcFlow adds its own once.
const lockListeners = vi.hoisted(() => new Set<() => void>())
const keyringServiceMock = vi.hoisted(() => ({
  hasOpenP2mrPsbtSigningBatches: vi.fn(() => true),
  hasVault: vi.fn(() => true),
  memStore: { getState: vi.fn(() => ({ isUnlocked: true })) },
  on: vi.fn((event: string, listener: () => void) => {
    if (event === 'lock') lockListeners.add(listener)
  }),
}))
const accountState = vi.hoisted(() => ({ address: 'qbrt1zaccount' }))
const walletMock = vi.hoisted(() => ({
  getChainType: vi.fn(() => 'QBIT_REGTEST'),
  getCurrentAccount: vi.fn(async () => ({ address: accountState.address })),
  releaseExternalQbitSigningLock: vi.fn(),
  openQbitProviderSendRequest: vi.fn(),
  releaseQbitRestoredFloorSigningChallenges: vi.fn(),
  releaseQbitSignatureBatches: vi.fn(),
  settleQbitProviderSendRequest: vi.fn(),
}))

vi.mock('../src/controllers/provider/controller', () => ({ default: providerControllerMock }))
vi.mock('../src/controllers/wallet', () => ({ default: walletMock }))
vi.mock('../src/services', () => ({
  keyringService: keyringServiceMock,
  permissionService: permissionServiceMock,
}))
vi.mock('src/services/approval', () => ({ default: approvalServiceMock }))
vi.mock('src/utils/eventBus', () => ({ bgEventBus: { emit: vi.fn() } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitForApproval(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (approvalServiceMock.requestApproval.mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('approval did not open')
}

function request(method: string, params: unknown) {
  return {
    data: { method, params },
    session: {
      origin: 'https://dapp.example',
      name: 'Dapp',
      icon: '',
    },
  }
}

/** The identity the guard hands a provider sendQbit request it opens. */
const SEND_REQUEST = 'provider-send-request-1'

function qbitSendBroadcastClaim() {
  return {
    chain: ChainType.QBIT_REGTEST,
    address: 'qbrt1zfunding',
    origin: 'https://dapp.example',
    txid: '33'.repeat(32),
    outpoints: [{ txid: '44'.repeat(32), vout: 1 }],
  }
}

/** What sendQbit throws when its broadcast of `claim`'s transaction ended without a verdict. */
function outcomeUnknownError(claim: { chain: ChainType; txid: string }) {
  return Object.assign(
    new WalletError(
      ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
      'Qbit transaction broadcast outcome is unknown; check the transaction before retrying'
    ),
    { data: { outcome: 'unknown', chain: claim.chain, txid: claim.txid } }
  )
}

function externalSigningLock(purpose: 'send' | 'sign' = 'send') {
  const claim = qbitSendBroadcastClaim()
  return {
    id: `external-${purpose}`,
    purpose,
    chain: claim.chain,
    address: claim.address,
    origin: claim.origin,
    entries: [{ txid: claim.txid, outpoints: claim.outpoints }],
  }
}

const BATCHES_FULL = 'Too many signing requests are waiting'

/**
 * The website requests' signature batches the keyring keeps open, as many as
 * it holds (64, its QBIT_PQC_SIGNATURE_BATCH_CAPACITY). A request's batch is
 * never evicted for another: once full, a new one is refused.
 */
function signatureBatchStore(capacity = 64) {
  const open = new Set<string>()
  let opened = 0
  return {
    open(): string {
      if (open.size >= capacity) throw new Error(BATCHES_FULL)
      opened += 1
      const id = `batch-${opened}`
      open.add(id)
      return id
    },
    release(batchIds: readonly string[]): void {
      for (const batchId of batchIds) open.delete(batchId)
    },
    isOpen: (id: string) => open.has(id),
  }
}

/**
 * A signPsbts approval that opens one batch for its entries and records it
 * on the request, as the controller's does; `prepared` stands for the time
 * its entries take to prepare.
 */
function openSignatureBatchOnApproval(
  batches: ReturnType<typeof signatureBatchStore>,
  prepared: () => Promise<void> = async () => undefined
) {
  Reflect.defineMetadata(
    'APPROVAL',
    [
      'SignPsbt',
      async req => {
        await prepared()
        const id = batches.open()
        req.data.params.toSignDatas = req.data.params.psbtHexs.map(
          (psbtHex: string, index: number) => ({ psbtHex, qbitSignatureBatch: { id, index } })
        )
        req.qbitSignatureBatchIds = [id]
      },
    ],
    providerControllerMock,
    'signPsbts'
  )
  walletMock.releaseQbitSignatureBatches.mockImplementation(batches.release)
}

/** The next approval waits for the test to settle it, under `approvalId`. */
function pendingApproval(approvalId: string) {
  const approval = deferred<unknown>()
  approvalServiceMock.requestApproval.mockImplementationOnce(
    (_data: unknown, _winProps: unknown, onPending?: (id: string) => void) => {
      onPending?.(approvalId)
      return approval.promise
    }
  )
  return approval
}

const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function signPsbtsRequest() {
  return request('signPsbts', {
    psbtHexs: ['70736274', '70736274'],
    options: [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST }],
  })
}

const APPROVAL_PENDING = 'Another approval request is already pending'

describe('Provider RPC security gates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    permissionState.allowed = true
    accountState.address = 'qbrt1zaccount'
    walletMock.getChainType.mockReturnValue(ChainType.QBIT_REGTEST)
    walletMock.releaseExternalQbitSigningLock.mockResolvedValue(true)
    walletMock.releaseQbitSignatureBatches.mockReset()
    keyringServiceMock.hasOpenP2mrPsbtSigningBatches.mockReturnValue(true)
    approvalServiceMock.rejectApproval.mockResolvedValue(false)
    walletMock.openQbitProviderSendRequest.mockResolvedValue(SEND_REQUEST)
    walletMock.settleQbitProviderSendRequest.mockResolvedValue(undefined)
    keyringServiceMock.memStore.getState.mockReturnValue({ isUnlocked: true })
    providerControllerMock.requestAccounts.mockResolvedValue(['qbrt1zaccount'])
    providerControllerMock.signMessage.mockResolvedValue('signed')
    providerControllerMock.signPsbt.mockResolvedValue('signed-psbt')
    providerControllerMock.signPsbts.mockResolvedValue(['signed-psbt'])
    providerControllerMock.sendQbit.mockResolvedValue('sent-txid')
    permissionServiceMock.addConnectedSite.mockResolvedValue(undefined)
    permissionServiceMock.touchConnectedSite.mockResolvedValue(undefined)
    permissionServiceMock.updateConnectSite.mockResolvedValue(undefined)
    // Reset too, so an approval a test left waiting is not handed to the next.
    approvalServiceMock.requestApproval.mockReset()
    approvalServiceMock.requestApproval.mockResolvedValue({ approved: true })
    Reflect.defineMetadata('APPROVAL', ['SignMessage'], providerControllerMock, 'signMessage')
    Reflect.defineMetadata('APPROVAL', ['SignPsbt'], providerControllerMock, 'signPsbt')
    Reflect.defineMetadata('APPROVAL', ['SignPsbt'], providerControllerMock, 'signPsbts')
    Reflect.defineMetadata('APPROVAL', ['SignPsbt'], providerControllerMock, 'sendQbit')
  })

  it('allows only requestAccounts to initiate a connection', async () => {
    permissionState.allowed = false
    permissionServiceMock.addConnectedSite.mockImplementationOnce(async () => {
      permissionState.allowed = true
    })
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(request('requestAccounts', undefined))).resolves.toEqual([
      'qbrt1zaccount',
    ])

    expect(approvalServiceMock.requestApproval).toHaveBeenCalledTimes(1)
    expect(permissionServiceMock.addConnectedSite).toHaveBeenCalledWith(
      'https://dapp.example',
      'Dapp',
      '',
      ChainType.QBIT_REGTEST
    )
    expect(providerControllerMock.requestAccounts).toHaveBeenCalledTimes(1)
  })

  it("answers with the method's result, whatever the approval window returned", async () => {
    approvalServiceMock.requestApproval.mockResolvedValue({ uiRequestComponent: 'SignMessage' })
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(request('signMessage', { text: 'approved' }))).resolves.toBe('signed')

    expect(approvalServiceMock.requestApproval).toHaveBeenCalledTimes(1)
    expect(providerControllerMock.signMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects privileged calls from a revoked origin without opening a reconnect approval', async () => {
    permissionState.allowed = false
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(request('signMessage', { text: 'must stay disconnected' }))
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHORIZED })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(permissionServiceMock.addConnectedSite).not.toHaveBeenCalled()
    expect(providerControllerMock.signMessage).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied private approval fields and unsupported message modes', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(request('signMessage', { text: 'hello', toSignMessages: [] }))
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })
    await expect(
      rpcFlow(request('signMessage', { text: 'hello', type: 'unsupported-mode' }))
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(providerControllerMock.signMessage).not.toHaveBeenCalled()
  })

  it('rejects a PSBT whose explicit chain differs from the active chain before approval', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('signPsbt', {
          psbtHex: '70736274',
          options: { chain: ChainType.QBIT_TESTNET4 },
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.UNSUPPORTED_NETWORK })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(providerControllerMock.signPsbt).not.toHaveBeenCalled()
  })

  it.each([
    ['an options key the wallet would ignore', { chain: ChainType.QBIT_REGTEST, toSignInputs: [] }],
    ['a string autoFinalized', { chain: ChainType.QBIT_REGTEST, autoFinalized: 'false' }],
    ['a numeric autoFinalized', { chain: ChainType.QBIT_REGTEST, autoFinalized: 0 }],
    ['a null autoFinalized', { chain: ChainType.QBIT_REGTEST, autoFinalized: null }],
    ['null options', null],
    ['array options', [{ chain: ChainType.QBIT_REGTEST }]],
    ['string options', ChainType.QBIT_REGTEST],
    ['missing options', undefined],
  ])('rejects signPsbt with %s before approval', async (_case, options) => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const params =
      options === undefined ? { psbtHex: '70736274' } : { psbtHex: '70736274', options }

    await expect(rpcFlow(request('signPsbt', params))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(providerControllerMock.signPsbt).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an unknown key on a later entry',
      ['70736274', '70736274'],
      [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST, toSignInputs: [] }],
    ],
    [
      'a string autoFinalized on a later entry',
      ['70736274', '70736274'],
      [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST, autoFinalized: 'true' }],
    ],
    // eslint-disable-next-line no-sparse-arrays
    ['a hole for an entry', ['70736274', '70736274'], [{ chain: ChainType.QBIT_REGTEST }, ,]],
    ['a null entry', ['70736274'], [null]],
    ['no PSBTs', [], []],
    [
      'more than 20 PSBTs',
      Array.from({ length: 21 }, () => '70736274'),
      Array.from({ length: 21 }, () => ({ chain: ChainType.QBIT_REGTEST })),
    ],
    ['fewer options than PSBTs', ['70736274', '70736274'], [{ chain: ChainType.QBIT_REGTEST }]],
    ['options that are not an array', ['70736274'], { chain: ChainType.QBIT_REGTEST }],
    ['PSBTs that are not an array', '70736274', [{ chain: ChainType.QBIT_REGTEST }]],
  ])('rejects signPsbts with %s before approval', async (_case, psbtHexs, options) => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(request('signPsbts', { psbtHexs, options }))).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(providerControllerMock.signPsbts).not.toHaveBeenCalled()
  })

  it('accepts the documented signPsbt and signPsbts options', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    for (const options of [
      { chain: ChainType.QBIT_REGTEST },
      { chain: ChainType.QBIT_REGTEST, autoFinalized: true },
      { chain: ChainType.QBIT_REGTEST, autoFinalized: false },
      { chain: ChainType.QBIT_REGTEST, autoFinalized: undefined },
    ]) {
      await expect(rpcFlow(request('signPsbt', { psbtHex: '70736274', options }))).resolves.toBe(
        'signed-psbt'
      )
    }
    await expect(
      rpcFlow(
        request('signPsbts', {
          psbtHexs: ['70736274', '70736274'],
          options: [
            { chain: ChainType.QBIT_REGTEST, autoFinalized: false },
            { chain: ChainType.QBIT_REGTEST },
          ],
        })
      )
    ).resolves.toEqual(['signed-psbt'])
    expect(providerControllerMock.signPsbt).toHaveBeenCalledTimes(4)
    expect(providerControllerMock.signPsbts).toHaveBeenCalledTimes(1)
  })

  it('keeps reporting a well-formed signPsbts entry for another chain as a network mismatch', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('signPsbts', {
          psbtHexs: ['70736274', '70736274'],
          options: [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_TESTNET4 }],
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.UNSUPPORTED_NETWORK })
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
  })

  it('rejects caller-controlled Qbit send policy and internal approval fields', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('sendQbit', {
          sendQbitParams: {
            toAddress: 'qbrt1zrecipient',
            satoshis: 40_000,
            enableRBF: true,
          },
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })
    await expect(
      rpcFlow(
        request('sendQbit', {
          sendQbitParams: {
            toAddress: 'qbrt1zrecipient',
            satoshis: 40_000,
          },
          toSignDatas: [],
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(providerControllerMock.sendQbit).not.toHaveBeenCalled()
  })

  it('rejects an origin revoked while its signing approval is open', async () => {
    const approval = deferred<Record<string, unknown>>()
    approvalServiceMock.requestApproval.mockReturnValueOnce(approval.promise)
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const pending = rpcFlow(request('signMessage', { text: 'exact text' }))

    await waitForApproval()
    permissionState.allowed = false
    approval.resolve({ approved: true })

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.UNAUTHORIZED })
    expect(providerControllerMock.signMessage).not.toHaveBeenCalled()
  })

  it('rejects approval payload mutation while the approval is open', async () => {
    const approval = deferred<Record<string, unknown>>()
    approvalServiceMock.requestApproval.mockReturnValueOnce(approval.promise)
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const req = request('signMessage', { text: 'approved text' })
    const pending = rpcFlow(req)

    await waitForApproval()
    ;(req.data.params as { text: string }).text = 'changed text'
    approval.resolve({ approved: true })

    await expect(pending).rejects.toThrow('approval payload changed')
    expect(providerControllerMock.signMessage).not.toHaveBeenCalled()
  })

  it('rejects account changes while the approval is open', async () => {
    const approval = deferred<Record<string, unknown>>()
    approvalServiceMock.requestApproval.mockReturnValueOnce(approval.promise)
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const pending = rpcFlow(request('signMessage', { text: 'approved text' }))

    await waitForApproval()
    accountState.address = 'qbrt1zdifferent'
    approval.resolve({ approved: true })

    await expect(pending).rejects.toThrow('context changed during approval')
    expect(providerControllerMock.signMessage).not.toHaveBeenCalled()
  })

  it('releases restored-floor signing challenges when a PSBT approval is rejected', async () => {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          req.data.params.toSignDatas = [
            { signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-a' } } },
            { signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-b' } } },
            { signatureBudget: {} },
          ]
        },
      ],
      providerControllerMock,
      'signPsbt'
    )
    approvalServiceMock.requestApproval.mockRejectedValueOnce(new Error('approval cancelled'))
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(request('signPsbt', { psbtHex: 'deadbeef', options: { chain: ChainType.QBIT_REGTEST } }))
    ).rejects.toThrow('approval cancelled')

    expect(walletMock.releaseQbitRestoredFloorSigningChallenges).toHaveBeenCalledWith([
      'challenge-a',
      'challenge-b',
    ])
  })

  it('releases the challenges of earlier signPsbts entries when a later entry is refused before approval', async () => {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          // As the batch condition leaves it when the second PSBT's prepare
          // refuses an autoFinalized the wallet cannot meet.
          req.data.params.toSignDatas = [
            { signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-a' } } },
          ]
          throw new WalletError(ErrorCodes.INVALID_PARAMS, 'autoFinalized cannot be met')
        },
      ],
      providerControllerMock,
      'signPsbts'
    )
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('signPsbts', {
          psbtHexs: ['70736274', '70736274'],
          options: [
            { chain: ChainType.QBIT_REGTEST, autoFinalized: true },
            { chain: ChainType.QBIT_REGTEST, autoFinalized: true },
          ],
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(walletMock.releaseQbitRestoredFloorSigningChallenges).toHaveBeenCalledWith([
      'challenge-a',
    ])
  })

  it('releases no challenge or batch a refused request names in its own parameters (#156)', async () => {
    // A recovery migration's review holds this challenge, and its batch
    // closes when the challenge is released; a page must reach neither.
    const pageEntry = {
      signatureBudget: { restoredFloorRisk: { challengeId: 'migration-challenge' } },
      qbitSignatureBatch: { id: 'migration-batch', index: 0 },
    }
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('signPsbts', {
          psbtHexs: ['70736274', '70736274'],
          options: [{ chain: ChainType.QBIT_REGTEST }, { chain: ChainType.QBIT_REGTEST }],
          toSignDatas: [pageEntry],
          toSignMessages: [pageEntry],
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })

    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(walletMock.releaseQbitRestoredFloorSigningChallenges).not.toHaveBeenCalled()
    expect(walletMock.releaseQbitSignatureBatches).not.toHaveBeenCalled()
  })

  it('releases restored-floor signing challenges when a message approval is rejected', async () => {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignMessage',
        async req => {
          req.data.params.toSignMessages = [
            { signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-msg' } } },
          ]
        },
      ],
      providerControllerMock,
      'signMessage'
    )
    approvalServiceMock.requestApproval.mockRejectedValueOnce(new Error('approval cancelled'))
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(request('signMessage', { text: 'hello' }))).rejects.toThrow(
      'approval cancelled'
    )

    expect(walletMock.releaseQbitRestoredFloorSigningChallenges).toHaveBeenCalledWith([
      'challenge-msg',
    ])
  })

  it('does not release restored-floor challenges when signing succeeds', async () => {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          req.data.params.toSignDatas = [
            { signatureBudget: { restoredFloorRisk: { challengeId: 'challenge-kept' } } },
          ]
        },
      ],
      providerControllerMock,
      'signPsbt'
    )
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(request('signPsbt', { psbtHex: 'deadbeef', options: { chain: ChainType.QBIT_REGTEST } }))).resolves.toBe(
      'signed-psbt'
    )

    expect(walletMock.releaseQbitRestoredFloorSigningChallenges).not.toHaveBeenCalled()
  })

  it('closes the signature batch of a signPsbts request whose approval is rejected', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    approvalServiceMock.requestApproval.mockRejectedValueOnce(new Error('approval cancelled'))
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(signPsbtsRequest())).rejects.toThrow('approval cancelled')

    expect(walletMock.releaseQbitSignatureBatches).toHaveBeenCalledWith(['batch-1'])
    expect(batches.isOpen('batch-1')).toBe(false)
  })

  it('closes the signature batch of a signPsbts request refused while another approval is pending', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    // The approval service refuses it after its condition opened the batch.
    approvalServiceMock.requestApproval.mockRejectedValueOnce(
      new WalletError(ErrorCodes.UNKNOWN, APPROVAL_PENDING)
    )
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(signPsbtsRequest())).rejects.toThrow(APPROVAL_PENDING)

    expect(batches.isOpen('batch-1')).toBe(false)
    expect(providerControllerMock.signPsbts).not.toHaveBeenCalled()
  })

  it('keeps the batch of a pending signPsbts request open through 65 requests refused meanwhile', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    const approval = deferred<unknown>()
    approvalServiceMock.requestApproval.mockReturnValueOnce(approval.promise)
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const live = rpcFlow(signPsbtsRequest())
    await waitForApproval()

    // Each opens a batch before the approval service refuses it. Left open,
    // the 64th would evict the pending request's.
    approvalServiceMock.requestApproval.mockRejectedValue(
      new WalletError(ErrorCodes.UNKNOWN, APPROVAL_PENDING)
    )
    for (let attempt = 0; attempt < 65; attempt += 1) {
      await expect(rpcFlow(signPsbtsRequest())).rejects.toThrow(APPROVAL_PENDING)
    }
    expect(batches.isOpen('batch-1')).toBe(true)
    expect(batches.isOpen('batch-66')).toBe(false)

    approval.resolve([{ psbtHex: 'signed-a' }, { psbtHex: 'signed-b' }])
    await expect(live).resolves.toEqual(['signed-psbt'])
    expect(providerControllerMock.signPsbts).toHaveBeenCalledTimes(1)
    expect(providerControllerMock.signPsbts.mock.calls[0]![0].data.params.toSignDatas).toEqual([
      { psbtHex: '70736274', qbitSignatureBatch: { id: 'batch-1', index: 0 } },
      { psbtHex: '70736274', qbitSignatureBatch: { id: 'batch-1', index: 1 } },
    ])
  })

  it('keeps the batch of a pending signPsbts request through 65 more fired at once', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches, macrotask)
    const signing = pendingApproval('approval-signing')
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const live = rpcFlow(signPsbtsRequest())
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (approvalServiceMock.requestApproval.mock.calls.length > 0) break
      await macrotask()
    }
    expect(approvalServiceMock.requestApproval).toHaveBeenCalledTimes(1)

    // Every request of the burst opens its batch before any is refused, and
    // each refusal comes a macrotask late, after the window focus.
    approvalServiceMock.requestApproval.mockImplementation(async () => {
      await macrotask()
      throw new WalletError(ErrorCodes.UNKNOWN, APPROVAL_PENDING)
    })
    const burst = await Promise.allSettled(
      Array.from({ length: 65 }, () => rpcFlow(signPsbtsRequest()))
    )
    const refusals = burst.map(result =>
      result.status === 'rejected' ? result.reason.message : ''
    )
    expect(refusals.filter(message => message === APPROVAL_PENDING)).toHaveLength(63)
    expect(refusals.filter(message => message === BATCHES_FULL)).toHaveLength(2)
    // Each closed only its own batch.
    expect(batches.isOpen('batch-1')).toBe(true)
    for (const [batchIds] of walletMock.releaseQbitSignatureBatches.mock.calls) {
      expect(batchIds).toHaveLength(1)
      expect(batchIds).not.toContain('batch-1')
    }

    signing.resolve([{ psbtHex: 'signed-a' }, { psbtHex: 'signed-b' }])
    await expect(live).resolves.toEqual(['signed-psbt'])
  })

  it('closes no batch a failed request names in its own parameters', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    pendingApproval('approval-signing')
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    void rpcFlow(signPsbtsRequest())
    await waitForApproval()

    await expect(
      rpcFlow(
        request('signPsbt', {
          psbtHex: 'deadbeef',
          options: { chain: ChainType.QBIT_REGTEST },
          toSignDatas: [{ qbitSignatureBatch: { id: 'batch-1', index: 0 } }],
        })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS })

    expect(walletMock.releaseQbitSignatureBatches).not.toHaveBeenCalled()
    expect(batches.isOpen('batch-1')).toBe(true)
  })

  it('ends a pending signPsbts approval when the wallet locks and closes its batch', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    const signing = pendingApproval('approval-signing')
    approvalServiceMock.rejectApproval.mockImplementation(async (id: string, err?: string) => {
      if (id !== 'approval-signing') return false
      signing.reject(new WalletError(ErrorCodes.UserCancel, err))
      return true
    })
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const live = rpcFlow(signPsbtsRequest())
    await waitForApproval()

    for (const listener of lockListeners) listener()

    await expect(live).rejects.toMatchObject({
      code: ErrorCodes.UserCancel,
      message: 'The wallet locked before this batch was signed; send the request again',
    })
    expect(approvalServiceMock.rejectApproval).toHaveBeenCalledTimes(1)
    expect(walletMock.releaseQbitSignatureBatches).toHaveBeenCalledWith(['batch-1'])
    expect(providerControllerMock.signPsbts).not.toHaveBeenCalled()
  })

  it('leaves a pending approval that holds no batch to the user when the wallet locks', async () => {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          req.data.params.toSignDatas = [{ psbtHex: 'deadbeef' }]
        },
      ],
      providerControllerMock,
      'signPsbt'
    )
    const signing = pendingApproval('approval-single')
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const live = rpcFlow(
      request('signPsbt', { psbtHex: 'deadbeef', options: { chain: ChainType.QBIT_REGTEST } })
    )
    await waitForApproval()

    for (const listener of lockListeners) listener()

    expect(approvalServiceMock.rejectApproval).not.toHaveBeenCalled()
    signing.resolve([{ psbtHex: 'signed' }])
    await expect(live).resolves.toBe('signed-psbt')
  })

  it('refuses a signPsbts request before its approval shows when a lock closed its batch', async () => {
    const batches = signatureBatchStore()
    openSignatureBatchOnApproval(batches)
    keyringServiceMock.hasOpenP2mrPsbtSigningBatches.mockReturnValue(false)
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(rpcFlow(signPsbtsRequest())).rejects.toMatchObject({
      code: ErrorCodes.UserCancel,
      message: 'The wallet locked before this batch was signed; send the request again',
    })
    expect(keyringServiceMock.hasOpenP2mrPsbtSigningBatches).toHaveBeenCalledWith(['batch-1'])
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(walletMock.releaseQbitSignatureBatches).toHaveBeenCalledWith(['batch-1'])
  })

  it('releases the exact external signing lease when approval is rejected', async () => {
    const lock = externalSigningLock('sign')
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          req.data.params.toSignDatas = [{ qbitExternalSigningLock: lock }]
        },
      ],
      providerControllerMock,
      'signPsbt'
    )
    approvalServiceMock.requestApproval.mockRejectedValueOnce(new Error('approval cancelled'))
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

    await expect(
      rpcFlow(
        request('signPsbt', {
          psbtHex: 'deadbeef',
          options: { chain: ChainType.QBIT_REGTEST },
        })
      )
    ).rejects.toThrow('approval cancelled')

    expect(walletMock.releaseExternalQbitSigningLock).toHaveBeenCalledWith(lock)
  })

  /** Give sendQbit approval data with `toSignData`, as its approval condition builds it. */
  function sendApprovalData(toSignData: Record<string, unknown>) {
    Reflect.defineMetadata(
      'APPROVAL',
      [
        'SignPsbt',
        async req => {
          req.data.params.toSignDatas = [toSignData]
        },
      ],
      providerControllerMock,
      'sendQbit'
    )
  }

  async function sendQbit() {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    return rpcFlow(
      request('sendQbit', {
        sendQbitParams: { toAddress: 'qbrt1zrecipient', satoshis: 40_000 },
      })
    )
  }

  it('opens the send request for its exact claim before the approval is shown', async () => {
    const claim = qbitSendBroadcastClaim()
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ qbitSendBroadcastClaim: claim }])
    // The answer does not wait on the send guard's queue.
    walletMock.settleQbitProviderSendRequest.mockReturnValueOnce(new Promise(() => undefined))

    await expect(sendQbit()).resolves.toBe('sent-txid')

    expect(walletMock.openQbitProviderSendRequest).toHaveBeenCalledWith(claim)
    expect(walletMock.openQbitProviderSendRequest.mock.invocationCallOrder[0]).toBeLessThan(
      approvalServiceMock.requestApproval.mock.invocationCallOrder[0]!
    )
    // A sent transaction spent its inputs: they stay reserved as recently
    // spent should its claim still be held.
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledTimes(1)
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, true)
  })

  it('releases the claim of a send whose approval is rejected without an answer', async () => {
    // The user signed (registering the claim under the request) and then
    // rejected, or the approval window closed: no approval answer carries
    // the claim, and the request releases it all the same.
    const claim = qbitSendBroadcastClaim()
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockRejectedValueOnce(
      new WalletError(ErrorCodes.UserCancel, 'User Cancel')
    )

    await expect(sendQbit()).rejects.toMatchObject({ code: ErrorCodes.UserCancel })

    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledTimes(1)
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
    expect(providerControllerMock.sendQbit).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing claim', undefined],
    [
      'a claim for another origin',
      { ...qbitSendBroadcastClaim(), origin: 'https://other.example' },
    ],
    ['a claim for another chain', { ...qbitSendBroadcastClaim(), chain: ChainType.QBIT_TESTNET4 }],
  ])('refuses send approval data with %s before the approval opens', async (_case, claim) => {
    sendApprovalData({ qbitSendBroadcastClaim: claim })

    await expect(sendQbit()).rejects.toThrow('invalid Qbit send broadcast claim')

    expect(walletMock.openQbitProviderSendRequest).not.toHaveBeenCalled()
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(walletMock.settleQbitProviderSendRequest).not.toHaveBeenCalled()
  })

  it('settles nothing when another request is already sending the same transaction', async () => {
    sendApprovalData({ qbitSendBroadcastClaim: qbitSendBroadcastClaim() })
    walletMock.openQbitProviderSendRequest.mockRejectedValueOnce(
      new Error('Another Qbit provider request is already sending this transaction')
    )

    await expect(sendQbit()).rejects.toThrow('already sending this transaction')

    // That claim belongs to the other request: this one never opened.
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(walletMock.settleQbitProviderSendRequest).not.toHaveBeenCalled()
  })

  it('cleans an external send at its exact lease and settles its request', async () => {
    const claim = qbitSendBroadcastClaim()
    const lock = externalSigningLock('send')
    const requestError = new Error('external send failed')
    sendApprovalData({ qbitSendBroadcastClaim: claim, qbitExternalSigningLock: lock })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ psbtHex: 'signed-psbt' }])
    providerControllerMock.sendQbit.mockRejectedValueOnce(requestError)

    await expect(sendQbit()).rejects.toBe(requestError)

    expect(walletMock.releaseExternalQbitSigningLock).toHaveBeenCalledWith(lock)
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
  })

  it('does not release a lease for mismatched external lock metadata', async () => {
    const claim = qbitSendBroadcastClaim()
    const lock = { ...externalSigningLock('send'), origin: 'https://other.example' }
    sendApprovalData({ qbitSendBroadcastClaim: claim, qbitExternalSigningLock: lock })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ psbtHex: 'signed-psbt' }])
    providerControllerMock.sendQbit.mockRejectedValueOnce(new Error('invalid external lock'))

    await expect(sendQbit()).rejects.toThrow('invalid external lock')

    expect(walletMock.releaseExternalQbitSigningLock).not.toHaveBeenCalled()
    // The request still settles: the guard decides only a claim filed under it.
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
  })

  it('releases the claim when post-sign request handling fails without sending', async () => {
    // Every failure sendQbit reports as a plain error happened before the
    // bytes left the wallet, or the broadcast was proven not sent: nothing
    // spends the inputs, so the claim goes.
    const claim = qbitSendBroadcastClaim()
    const requestError = new Error('normal send broadcast failed')
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ qbitSendBroadcastClaim: claim }])
    providerControllerMock.sendQbit.mockRejectedValueOnce(requestError)

    await expect(sendQbit()).rejects.toBe(requestError)

    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
  })

  it('keeps the inputs reserved when the broadcast outcome is unknown', async () => {
    const claim = qbitSendBroadcastClaim()
    const unknown = outcomeUnknownError(claim)
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ qbitSendBroadcastClaim: claim }])
    providerControllerMock.sendQbit.mockRejectedValueOnce(unknown)

    // The dapp gets the distinct code and the txid to check, and the request
    // settles its claim as spent rather than releasing it: the node may hold
    // the transaction, so its inputs stay reserved as recently spent until a
    // probe settles them.
    const error = await sendQbit().catch(caught => caught)
    expect(error).toBe(unknown)
    expect(error.code).toBe(ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN)
    expect(error.data).toEqual({ outcome: 'unknown', chain: claim.chain, txid: claim.txid })
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, true)
  })

  it('keeps the inputs of an external send reserved when the broadcast outcome is unknown', async () => {
    const claim = qbitSendBroadcastClaim()
    const lock = externalSigningLock('send')
    sendApprovalData({ qbitSendBroadcastClaim: claim, qbitExternalSigningLock: lock })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ psbtHex: 'signed-psbt' }])
    // The lock was promoted to the claim before the broadcast.
    walletMock.releaseExternalQbitSigningLock.mockResolvedValueOnce(false)
    providerControllerMock.sendQbit.mockRejectedValueOnce(outcomeUnknownError(claim))

    await expect(sendQbit()).rejects.toMatchObject({
      code: ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
    })

    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, true)
  })

  it('releases the claim when an unknown-outcome error names another transaction', async () => {
    const claim = qbitSendBroadcastClaim()
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([{ qbitSendBroadcastClaim: claim }])
    providerControllerMock.sendQbit.mockRejectedValueOnce(
      outcomeUnknownError({ chain: claim.chain, txid: '55'.repeat(32) })
    )

    await expect(sendQbit()).rejects.toMatchObject({
      code: ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
    })

    // Only a verdict about this claim's own transaction can keep its inputs.
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
  })

  it.each([
    ['pushTx', { rawtx: 'ab'.repeat(60) }],
    ['pushPsbt', { psbtHex: 'ab'.repeat(60) }],
  ] as const)(
    'hands a %s unknown outcome to the dapp unchanged, with no send request to settle',
    async (method, params) => {
      const unknown = outcomeUnknownError({ chain: ChainType.QBIT_REGTEST, txid: '55'.repeat(32) })
      providerControllerMock[method].mockRejectedValueOnce(unknown)
      const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default

      // The code and the txid reach the page provider as the controller
      // threw them; a push holds no claim, so nothing is released.
      const error = await rpcFlow(request(method, params)).catch(caught => caught)
      expect(error).toBe(unknown)
      expect(error.data).toEqual({
        outcome: 'unknown',
        chain: ChainType.QBIT_REGTEST,
        txid: '55'.repeat(32),
      })
      expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
      expect(walletMock.openQbitProviderSendRequest).not.toHaveBeenCalled()
      expect(walletMock.settleQbitProviderSendRequest).not.toHaveBeenCalled()
      expect(walletMock.releaseExternalQbitSigningLock).not.toHaveBeenCalled()
    }
  )

  it('settles the request it opened whatever claim the approval answers with', async () => {
    const claim = qbitSendBroadcastClaim()
    sendApprovalData({ qbitSendBroadcastClaim: claim })
    approvalServiceMock.requestApproval.mockResolvedValueOnce([
      {
        qbitSendBroadcastClaim: {
          ...claim,
          origin: 'https://other.example',
        },
      },
    ])
    providerControllerMock.sendQbit.mockRejectedValueOnce(new Error('invalid signed claim'))

    await expect(sendQbit()).rejects.toThrow('invalid signed claim')

    // The answer names no claim to release: the request decides only the
    // claim filed under it, never one the answer names.
    expect(walletMock.openQbitProviderSendRequest).toHaveBeenCalledWith(claim)
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledTimes(1)
    expect(walletMock.settleQbitProviderSendRequest).toHaveBeenCalledWith(SEND_REQUEST, false)
  })
})
