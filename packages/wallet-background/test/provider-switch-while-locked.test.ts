import 'reflect-metadata'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'
import type { ApprovalService } from '@qbit/approval-service'

// A website switch requested while the wallet is locked asks for the unlock
// first, and its approval then carries the unlocked wallet's context. These
// tests drive the real rpcFlow, the real provider controller and a real
// ApprovalService.

const ACCOUNT = 'tq1zaccount'

const background = vi.hoisted(() => {
  const keyringState = { isUnlocked: true }
  const state = { chain: 'QBIT_TESTNET4', account: '', grants: new Map<string, string>() }
  return {
    keyringState,
    state,
    approvalService: undefined as unknown as ApprovalService,
    keyringService: {
      hasVault: () => true,
      memStore: { getState: () => keyringState },
    },
    permissionService: {
      hasPermission: vi.fn((origin: string, chain: string) => state.grants.get(origin) === chain),
      touchConnectedSite: vi.fn(),
      updateConnectSite: vi.fn(),
    },
    sessionService: { broadcastEvent: vi.fn() },
    wallet: {
      getChainType: vi.fn(() => state.chain),
      // Locking clears the keyrings: no account is readable until the unlock.
      getCurrentAccount: vi.fn(async () =>
        keyringState.isUnlocked ? { address: state.account } : null
      ),
      // As WalletController.switchProviderChain: the requester's grant moves with the chain.
      switchProviderChain: vi.fn(async (origin: string, chain: string) => {
        state.grants.set(origin, chain)
        state.chain = chain
      }),
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
  sessionService: background.sessionService,
}))

vi.mock('../src/services/regtestAccess', () => ({
  default: { assertAvailable: vi.fn() },
}))

vi.mock('../src/controllers/wallet', () => ({ default: background.wallet }))

const session = { origin: 'https://dapp.example', name: 'Dapp', icon: '' }

const SWITCHES = [
  ['switchChain', { chain: ChainType.QBIT_MAINNET }, 'SwitchChain'],
  ['switchNetwork', { network: 'mainnet' }, 'SwitchNetwork'],
] as const

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
  return approval as { id: string; data: any }
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 10))
}

async function loadRpcFlow() {
  return (await import('../src/controllers/provider/rpcFlow')).default
}

/**
 * What the user does in the approval window the request opened: unlock the
 * wallet (which settles only an unlock request, as resolveUnlockApproval
 * does), then look at the switch approval that follows.
 */
async function unlockFromApprovalWindow(component: string) {
  await vi.waitFor(() => expect(background.approvalService.getApproval()).toBeTruthy())
  const first = pendingApproval()
  background.keyringState.isUnlocked = true
  if (first.data.lock === true) {
    await background.approvalService.resolveApproval(first.id)
  }
  await vi.waitFor(() => expect(pendingApproval().data.approvalComponent).toBe(component))
  return { first, switchApproval: pendingApproval() }
}

describe('website switch requested while the wallet is locked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    background.keyringState.isUnlocked = false
    background.state.chain = ChainType.QBIT_TESTNET4
    background.state.account = ACCOUNT
    background.state.grants.clear()
    background.state.grants.set(session.origin, ChainType.QBIT_TESTNET4)
  })

  afterEach(async () => {
    const approval = background.approvalService.getApproval()
    if (approval) await background.approvalService.rejectApproval(approval.id)
  })

  it.each(SWITCHES)(
    '%s asks for the unlock first and succeeds after unlock and approval',
    async (method, params, component) => {
      const rpcFlow = await loadRpcFlow()
      const request = track(rpcFlow({ data: { method, params }, session }))

      const { first, switchApproval } = await unlockFromApprovalWindow(component)

      // The unlock alone switches nothing: the switch still waits for the user.
      await flush()
      expect(request.settled).toBe(false)
      expect(background.wallet.switchProviderChain).not.toHaveBeenCalled()

      await background.approvalService.resolveApproval(switchApproval.id)
      await vi.waitFor(() => expect(request.settled).toBe(true))
      expect(request.error).toBeUndefined()
      expect(background.wallet.switchProviderChain).toHaveBeenCalledOnce()
      expect(background.wallet.switchProviderChain).toHaveBeenCalledWith(
        session.origin,
        ChainType.QBIT_MAINNET
      )

      expect(first.data).toEqual({ lock: true })
      // The switch approval showed the context read after the unlock.
      expect(switchApproval.data.params.context).toEqual({
        origin: session.origin,
        account: ACCOUNT,
        chain: ChainType.QBIT_TESTNET4,
        network: 'testnet4',
      })
      expect(switchApproval.data.params.data).toEqual(params)
    }
  )

  it.each(SWITCHES)(
    '%s fails closed when the account changes after the unlock, before the approval',
    async (method, params, component) => {
      const rpcFlow = await loadRpcFlow()
      const request = track(rpcFlow({ data: { method, params }, session }))

      const { switchApproval } = await unlockFromApprovalWindow(component)
      expect(switchApproval.data.params.context.account).toBe(ACCOUNT)

      // The approval was shown for one account; the wallet now acts for another.
      background.state.account = 'tq1zother'
      await background.approvalService.resolveApproval(switchApproval.id)

      await vi.waitFor(() => expect(request.settled).toBe(true))
      expect(request.error).toMatchObject({
        message: 'Qbit provider context changed during approval',
      })
      expect(background.wallet.switchProviderChain).not.toHaveBeenCalled()
      expect(background.state.chain).toBe(ChainType.QBIT_TESTNET4)
    }
  )
})
