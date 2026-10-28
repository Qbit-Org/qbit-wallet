import 'reflect-metadata'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '@qbit/wallet-shared'
import type { ApprovalService } from '@qbit/approval-service'
import type { ProviderPage } from '../src/controllers/provider/rpcFlow'
import type { WalletController } from '../src/controllers/wallet'

// A website approval ends with the page that asked for it: nothing is signed
// or sent for a page that is gone, at whatever step it goes. These tests drive
// the real rpcFlow, a real ApprovalService and the real
// WalletController.resolveUnlockApproval.

const background = vi.hoisted(() => {
  const connectedOrigins = new Set<string>()
  const keyringState = { isUnlocked: true }
  return {
    connectedOrigins,
    keyringState,
    approvalService: undefined as unknown as ApprovalService,
    keyringService: {
      hasVault: () => true,
      memStore: { getState: () => keyringState },
    },
    permissionService: {
      addConnectedSite: vi.fn((origin: string) => {
        connectedOrigins.add(origin)
      }),
      hasPermission: vi.fn((origin: string) => connectedOrigins.has(origin)),
      touchConnectedSite: vi.fn(),
      updateConnectSite: vi.fn(),
    },
    wallet: {
      getChainType: vi.fn(() => 'QBIT_REGTEST'),
      getCurrentAccount: vi.fn(async () => ({ address: 'qbrt1zaccount' })),
      openQbitProviderSendRequest: vi.fn(async (claim: unknown) => ({ claim })),
      settleQbitProviderSendRequest: vi.fn(async () => undefined),
      releaseExternalQbitSigningLock: vi.fn(async () => undefined),
      releaseQbitRestoredFloorSigningChallenges: vi.fn(async () => undefined),
    },
    // The provider methods that sign or broadcast once a request is approved.
    controller: {
      requestAccounts: vi.fn(async () => ['qbrt1zaccount']),
      sendQbit: vi.fn(async () => 'broadcast-txid'),
      signMessage: vi.fn(async () => 'signature'),
    },
  }
})

vi.mock('src/services/approval', async () => {
  const { ApprovalService } = await import('@qbit/approval-service')
  background.approvalService = new ApprovalService()
  return { default: background.approvalService }
})

vi.mock('src/utils/eventBus', () => ({ bgEventBus: { emit: vi.fn() } }))

vi.mock('../src/services', () => ({
  keyringService: background.keyringService,
  permissionService: background.permissionService,
}))

vi.mock('../src/controllers/wallet', () => ({ default: background.wallet }))

vi.mock('../src/controllers/provider/controller', () => {
  Reflect.defineMetadata(
    'APPROVAL',
    [
      'SignPsbt',
      // As the real condition does, the background mints the send's claim.
      async (req: any) => {
        req.data.params.toSignDatas = [
          {
            psbtHex: '70736274ff',
            qbitSendBroadcastClaim: {
              chain: 'QBIT_REGTEST',
              origin: req.session.origin,
              txid: 'aa'.repeat(32),
            },
          },
        ]
      },
    ],
    background.controller,
    'sendQbit'
  )
  Reflect.defineMetadata('APPROVAL', ['SignMessage'], background.controller, 'signMessage')
  return { default: background.controller }
})

const SEND = { method: 'sendQbit', params: { sendQbitParams: { toAddress: 'qbrt1zto', satoshis: 1000 } } }
const SIGN = { method: 'signMessage', params: { text: 'hello' } }
const PAGE_GONE = 'Qbit provider page closed before the request completed'

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: any } = { settled: false }
  promise.then(
    value => Object.assign(state, { settled: true, value }),
    error => Object.assign(state, { settled: true, error })
  )
  return state
}

function pendingApproval() {
  const approval = background.approvalService.getApproval()
  if (!approval) throw new Error('no approval is pending')
  return approval
}

function pendingComponent() {
  const data = background.approvalService.getApproval()?.data
  return data && 'approvalComponent' in data ? data.approvalComponent : undefined
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 10))
}

async function loadRpcFlow() {
  return (await import('../src/controllers/provider/rpcFlow')).default
}

async function createWalletController(): Promise<WalletController> {
  const actual = await vi.importActual<typeof import('../src/controllers/wallet')>(
    '../src/controllers/wallet'
  )
  return new actual.WalletController()
}

/**
 * A page as the extension's provider transport presents it to rpcFlow, and
 * its port disconnecting as that transport handles it: the page's signal
 * aborts and the approvals its requests wait on are rejected.
 */
async function openPage(origin: string) {
  const rpcFlow = await loadRpcFlow()
  const pageGone = new AbortController()
  const page: ProviderPage = { signal: pageGone.signal, approvalIds: new Set() }
  const session = { origin, name: 'Dapp', icon: '' }
  return {
    page,
    session,
    request: (data: unknown) => rpcFlow({ data, session, page }),
    disconnect() {
      pageGone.abort()
      for (const approvalId of page.approvalIds) {
        void background.approvalService.rejectApproval(
          approvalId,
          'The page that made this request is gone'
        )
      }
      page.approvalIds.clear()
    },
  }
}

describe('provider requests whose page goes away', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    background.connectedOrigins.clear()
    background.connectedOrigins.add('https://first.example')
    background.connectedOrigins.add('https://second.example')
    background.keyringState.isUnlocked = true
  })

  afterEach(async () => {
    const approval = background.approvalService.getApproval()
    if (approval) await background.approvalService.rejectApproval(approval.id)
    await flush()
  })

  it('rejects the pending sendQbit approval of a page that goes away, so a stale Approve sends nothing', async () => {
    const first = await openPage('https://first.example')
    const request = track(first.request(structuredClone(SEND)))
    await vi.waitFor(() => expect(pendingComponent()).toBe('SignPsbt'))
    const approvalId = pendingApproval().id
    // The request keeps the id of the approval it waits on with its page.
    expect([...first.page.approvalIds]).toEqual([approvalId])

    first.disconnect()

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error).toMatchObject({ code: ErrorCodes.UserCancel })
    expect(background.approvalService.getApproval()).toBeUndefined()
    // The approval window, still showing, approves too late.
    await expect(
      background.approvalService.resolveApproval(approvalId, [{ psbtHex: '70736274ff' }])
    ).resolves.toBe(false)
    await flush()
    expect(background.controller.sendQbit).not.toHaveBeenCalled()
    // The send's claim is released: its inputs are free for another send.
    expect(background.wallet.settleQbitProviderSendRequest).toHaveBeenCalledOnce()
    expect(background.wallet.settleQbitProviderSendRequest).toHaveBeenCalledWith(
      expect.anything(),
      false
    )
  })

  it('sends nothing when the page goes away right after the user approves', async () => {
    const first = await openPage('https://first.example')
    const request = track(first.request(structuredClone(SEND)))
    await vi.waitFor(() => expect(pendingComponent()).toBe('SignPsbt'))

    const approved = background.approvalService.resolveApproval(pendingApproval().id, [
      { psbtHex: '70736274ff' },
    ])
    // The approval is settled, so only the request itself can notice.
    first.disconnect()
    await expect(approved).resolves.toBe(true)

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error).toMatchObject({ message: PAGE_GONE })
    expect(background.controller.sendQbit).not.toHaveBeenCalled()
    expect(background.wallet.settleQbitProviderSendRequest).toHaveBeenCalledWith(
      expect.anything(),
      false
    )
  })

  it('signs nothing when the page goes away after the approval was accepted', async () => {
    const first = await openPage('https://first.example')
    // Between the approval step and the execution step.
    background.permissionService.updateConnectSite.mockImplementationOnce(async () => {
      first.disconnect()
    })
    const request = track(first.request(structuredClone(SIGN)))
    await vi.waitFor(() => expect(pendingComponent()).toBe('SignMessage'))

    await expect(
      background.approvalService.resolveApproval(pendingApproval().id, ['signature'])
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error).toMatchObject({ message: PAGE_GONE })
    expect(background.permissionService.updateConnectSite).toHaveBeenCalledOnce()
    expect(background.controller.signMessage).not.toHaveBeenCalled()
  })

  it('shows no approval for a page that went away before it was asked', async () => {
    const first = await openPage('https://first.example')
    const openWindow = vi.spyOn(background.approvalService, 'platformOpenWindow')
    // While the send is prepared, before its approval is requested.
    background.wallet.openQbitProviderSendRequest.mockImplementationOnce(async claim => {
      first.disconnect()
      return { claim }
    })

    await expect(first.request(structuredClone(SEND))).rejects.toThrow(PAGE_GONE)
    expect(background.approvalService.getApproval()).toBeUndefined()
    expect(openWindow).not.toHaveBeenCalled()
    expect(background.controller.sendQbit).not.toHaveBeenCalled()
    expect(background.wallet.settleQbitProviderSendRequest).toHaveBeenCalledWith(
      expect.anything(),
      false
    )
  })

  it('grants no connection to a page that went away while its Connect was pending', async () => {
    const page = await openPage('https://new.example')
    const request = track(page.request({ method: 'requestAccounts' }))
    await vi.waitFor(() => expect(pendingComponent()).toBe('Connect'))
    const approvalId = pendingApproval().id

    page.disconnect()

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error).toMatchObject({ code: ErrorCodes.UserCancel })
    await expect(background.approvalService.resolveApproval(approvalId)).resolves.toBe(false)
    await flush()
    expect(background.permissionService.addConnectedSite).not.toHaveBeenCalled()
    expect(background.controller.requestAccounts).not.toHaveBeenCalled()
  })

  it("leaves another page's pending approval alone", async () => {
    const first = await openPage('https://first.example')
    const second = await openPage('https://second.example')
    const request = track(first.request(structuredClone(SIGN)))
    await vi.waitFor(() => expect(pendingComponent()).toBe('SignMessage'))
    const approvalId = pendingApproval().id

    second.disconnect()
    await flush()

    expect(pendingApproval().id).toBe(approvalId)
    expect(request.settled).toBe(false)
    await expect(
      background.approvalService.resolveApproval(approvalId, ['signature'])
    ).resolves.toBe(true)
    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.value).toBe('signature')
    expect(background.controller.signMessage).toHaveBeenCalledOnce()
  })

  it('keeps the shared unlock request for the other waiting page when one page goes away', async () => {
    const wallet = await createWalletController()
    const first = await openPage('https://first.example')
    const second = await openPage('https://second.example')
    background.keyringState.isUnlocked = false

    const firstRequest = track(first.request(structuredClone(SIGN)))
    await vi.waitFor(() =>
      expect(background.approvalService.getApproval()?.data).toEqual({ lock: true })
    )
    const unlockId = pendingApproval().id
    const secondRequest = track(second.request(structuredClone(SIGN)))
    await flush()
    // Both wait on the one unlock request; no page holds it.
    expect(pendingApproval().id).toBe(unlockId)
    expect(first.page.approvalIds.size).toBe(0)
    expect(second.page.approvalIds.size).toBe(0)

    first.disconnect()

    await vi.waitFor(() => expect(firstRequest.settled).toBe(true))
    expect(firstRequest.error).toMatchObject({ message: PAGE_GONE })
    expect(pendingApproval().id).toBe(unlockId)
    expect(secondRequest.settled).toBe(false)

    // The user unlocks; the other page's request goes on to its approval.
    background.keyringState.isUnlocked = true
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(true)
    await vi.waitFor(() => expect(pendingComponent()).toBe('SignMessage'))
    const signApproval = pendingApproval()
    expect(signApproval.data).toMatchObject({
      params: { session: { origin: 'https://second.example' } },
    })
    expect([...second.page.approvalIds]).toEqual([signApproval.id])

    await expect(
      background.approvalService.resolveApproval(signApproval.id, ['signature'])
    ).resolves.toBe(true)
    await vi.waitFor(() => expect(secondRequest.settled).toBe(true))
    expect(secondRequest.value).toBe('signature')
    expect(background.controller.signMessage).toHaveBeenCalledOnce()
    expect(background.controller.signMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session: second.session })
    )
    expect(second.page.approvalIds.size).toBe(0)
  })
})
