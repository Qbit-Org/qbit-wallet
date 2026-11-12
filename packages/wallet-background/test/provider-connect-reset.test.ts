import 'reflect-metadata'

import { describe, expect, it, vi } from 'vitest'
import type { ApprovalService } from '@qbit/approval-service'
import type { ProviderPage } from '../src/controllers/provider/rpcFlow'

// A Connect the user approved just before a reset began to erase the wallet:
// the real rpcFlow checks the request again after the approval, and must not
// give the site a grant that the reset's clearing of the grants could miss.

const background = vi.hoisted(() => {
  const connectedOrigins = new Set<string>()
  return {
    connectedOrigins,
    approvalService: undefined as unknown as ApprovalService,
    keyringService: {
      hasVault: () => true,
      memStore: { getState: () => ({ isUnlocked: true }) },
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
      walletResetGeneration: 0,
      getChainType: vi.fn(() => 'QBIT_REGTEST'),
      getCurrentAccount: vi.fn(async () => ({ address: 'qbrt1zaccount' })),
    },
    controller: {
      requestAccounts: vi.fn(async () => ['qbrt1zaccount']),
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

vi.mock('../src/controllers/provider/controller', () => ({ default: background.controller }))

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: any } = { settled: false }
  promise.then(
    value => Object.assign(state, { settled: true, value }),
    error => Object.assign(state, { settled: true, error })
  )
  return state
}

function pendingConnect() {
  const approval = background.approvalService.getApproval()
  const data = approval?.data
  return approval && data && 'approvalComponent' in data && data.approvalComponent === 'Connect'
    ? approval
    : undefined
}

async function requestAccounts(origin: string) {
  const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
  const page: ProviderPage = { signal: new AbortController().signal, approvalIds: new Set() }
  return track(
    rpcFlow({
      data: { method: 'requestAccounts' },
      session: { origin, name: 'Dapp', icon: '' },
      page,
    })
  )
}

describe('a Connect approved as a reset begins', () => {
  it('gives no grant when the reset began to erase the wallet while the approved request was checked', async () => {
    const request = await requestAccounts('https://new.example')
    await vi.waitFor(() => expect(pendingConnect()).toBeDefined())
    // The check after the approval reads the account again. A reset begins to
    // erase the wallet meanwhile, and the read, begun before it, still answers
    // with the account.
    background.wallet.getCurrentAccount.mockImplementationOnce(async () => {
      background.wallet.walletResetGeneration += 1
      return { address: 'qbrt1zaccount' }
    })

    await background.approvalService.resolveApproval(pendingConnect()!.id)

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error?.message).toBe('Qbit provider context changed during approval')
    expect(background.permissionService.addConnectedSite).not.toHaveBeenCalled()
    expect(background.controller.requestAccounts).not.toHaveBeenCalled()
  })

  it('connects the site when no reset began meanwhile', async () => {
    const request = await requestAccounts('https://other.example')
    await vi.waitFor(() => expect(pendingConnect()).toBeDefined())

    await background.approvalService.resolveApproval(pendingConnect()!.id)

    await vi.waitFor(() => expect(request.settled).toBe(true))
    expect(request.error).toBeUndefined()
    expect(background.permissionService.addConnectedSite).toHaveBeenCalledWith(
      'https://other.example',
      'Dapp',
      '',
      'QBIT_REGTEST'
    )
  })
})
