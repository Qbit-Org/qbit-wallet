import 'reflect-metadata'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'
import type { ApprovalService } from '@qbit/approval-service'
import { getUiControllerMethod } from '../src/controllers/ui-access'
import type { WalletController } from '../src/controllers/wallet'

// An unlock may settle only rpcFlow's unlock request ({ lock: true }); any
// other approval waits for the user (#267). These tests drive the real rpcFlow,
// a real ApprovalService and the real WalletController.resolveUnlockApproval.

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
    },
    controller: {
      requestAccounts: vi.fn(async () => ['qbrt1zaccount']),
      switchChain: vi.fn(async () => undefined),
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

// rpcFlow's view of the wallet controller; resolveUnlockApproval is tested on
// a real WalletController instance below.
vi.mock('../src/controllers/wallet', () => ({ default: background.wallet }))

vi.mock('../src/controllers/provider/controller', () => {
  Reflect.defineMetadata(
    'APPROVAL',
    ['SwitchChain', async () => false],
    background.controller,
    'switchChain'
  )
  return { default: background.controller }
})

const session = { origin: 'https://dapp.example', name: 'Dapp', icon: '' }

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false }
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

describe('provider approvals across a wallet lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    background.connectedOrigins.clear()
    background.keyringState.isUnlocked = true
  })

  afterEach(async () => {
    const approval = background.approvalService.getApproval()
    if (approval) await background.approvalService.rejectApproval(approval.id)
  })

  it('resolves the unlock request once, so a second unlock cannot approve the Connect after it', async () => {
    const rpcFlow = await loadRpcFlow()
    const wallet = await createWalletController()
    background.keyringState.isUnlocked = false
    const request = track(rpcFlow({ data: { method: 'requestAccounts' }, session }))

    await vi.waitFor(() =>
      expect(background.approvalService.getApproval()?.data).toEqual({ lock: true })
    )
    // Still locked: nothing to settle yet.
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(false)
    expect(background.approvalService.getApproval()?.data).toEqual({ lock: true })

    background.keyringState.isUnlocked = true
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(true)
    await vi.waitFor(() => expect(pendingComponent()).toBe('Connect'))

    // A second window that also saw the unlock request now finishes its unlock.
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(false)
    await flush()
    expect(pendingComponent()).toBe('Connect')
    expect(background.permissionService.addConnectedSite).not.toHaveBeenCalled()
    expect(request.settled).toBe(false)

    // The user's explicit Connect still completes the request.
    await background.approvalService.resolveApproval(pendingApproval().id)
    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.value).toEqual(['qbrt1zaccount'])
    expect(background.permissionService.addConnectedSite).toHaveBeenCalledWith(
      session.origin,
      session.name,
      session.icon,
      ChainType.QBIT_REGTEST
    )
  })

  it('leaves a Connect approval that outlived a lock pending, and no lock request displaces it', async () => {
    const rpcFlow = await loadRpcFlow()
    const wallet = await createWalletController()
    const connect = track(rpcFlow({ data: { method: 'requestAccounts' }, session }))
    await vi.waitFor(() => expect(pendingComponent()).toBe('Connect'))

    background.keyringState.isUnlocked = false
    await expect(
      rpcFlow({
        data: { method: 'requestAccounts' },
        session: { ...session, origin: 'https://other.example' },
      })
    ).rejects.toThrow('Another approval request is already pending')

    background.keyringState.isUnlocked = true
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(false)
    await flush()
    expect(pendingComponent()).toBe('Connect')
    expect(background.permissionService.addConnectedSite).not.toHaveBeenCalled()
    expect(connect.settled).toBe(false)
  })

  it('leaves a SwitchChain approval that outlived a lock pending', async () => {
    const rpcFlow = await loadRpcFlow()
    const wallet = await createWalletController()
    background.connectedOrigins.add(session.origin)
    const request = track(
      rpcFlow({ data: { method: 'switchChain', params: { chain: 'QBIT_TESTNET4' } }, session })
    )
    await vi.waitFor(() => expect(pendingComponent()).toBe('SwitchChain'))

    await expect(wallet.resolveUnlockApproval()).resolves.toBe(false)
    await flush()
    expect(background.controller.switchChain).not.toHaveBeenCalled()
    expect(request.settled).toBe(false)

    await background.approvalService.resolveApproval(pendingApproval().id)
    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(background.controller.switchChain).toHaveBeenCalledOnce()
  })

  it('a window that read the unlock request cannot settle the Connect that replaced it', async () => {
    const rpcFlow = await loadRpcFlow()
    const wallet = await createWalletController()
    // Through the UI port's dispatch, as a wallet window calls these.
    const getApproval = getUiControllerMethod(wallet, 'getApproval')
    const resolveApproval = getUiControllerMethod(wallet, 'resolveApproval')
    const rejectApproval = getUiControllerMethod(wallet, 'rejectApproval')
    background.keyringState.isUnlocked = false
    const request = track(rpcFlow({ data: { method: 'requestAccounts' }, session }))
    await vi.waitFor(() =>
      expect(background.approvalService.getApproval()?.data).toEqual({ lock: true })
    )
    const unlockWindow = (await getApproval()) as { id: string }

    background.keyringState.isUnlocked = true
    await expect(wallet.resolveUnlockApproval()).resolves.toBe(true)
    await vi.waitFor(() => expect(pendingComponent()).toBe('Connect'))
    const connectId = pendingApproval().id
    expect(connectId).not.toBe(unlockWindow.id)

    await expect(resolveApproval(unlockWindow.id)).resolves.toBe(false)
    await expect(resolveApproval(unlockWindow.id, undefined, true)).resolves.toBe(false)
    await expect(rejectApproval(unlockWindow.id, 'stale window')).resolves.toBe(false)
    // A caller that still sends the old (data, forceReject) arguments matches nothing.
    await expect(resolveApproval(undefined, false)).resolves.toBe(false)
    await expect(rejectApproval('User rejected', false, false)).resolves.toBe(false)
    await flush()
    expect(pendingApproval().id).toBe(connectId)
    expect(request.settled).toBe(false)
    expect(background.permissionService.addConnectedSite).not.toHaveBeenCalled()

    const connectWindow = (await getApproval()) as { id: string }
    await expect(resolveApproval(connectWindow.id)).resolves.toBe(true)
    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.value).toEqual(['qbrt1zaccount'])
  })
})
