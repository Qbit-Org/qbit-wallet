import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainType } from '@qbit/wallet-types'

const verifyMessageMock = vi.hoisted(() => vi.fn())
const approvalServiceMock = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  unLock: vi.fn(),
}))
const keyringServiceMock = vi.hoisted(() => ({
  hasVault: vi.fn(() => true),
  memStore: {
    getState: vi.fn(() => ({ isUnlocked: true })),
  },
}))
const walletMock = vi.hoisted(() => ({
  getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
  getCurrentAccount: vi.fn(async () => ({ address: 'qbrt1zaccount' })),
}))
const permissionServiceMock = vi.hoisted(() => ({
  addConnectedSite: vi.fn(),
  hasPermission: vi.fn(() => false),
  touchConnectedSite: vi.fn(),
  updateConnectSite: vi.fn(),
}))

vi.mock('../src/controllers/provider/controller', () => ({
  default: {
    verifyMessage: verifyMessageMock,
  },
}))

vi.mock('../src/controllers/wallet', () => ({ default: walletMock }))

vi.mock('../src/services', () => ({
  keyringService: keyringServiceMock,
  permissionService: permissionServiceMock,
}))

vi.mock('src/services/approval', () => ({
  default: approvalServiceMock,
}))

vi.mock('src/utils/eventBus', () => ({
  bgEventBus: { emit: vi.fn() },
}))

describe('Provider RPC flow P2MR verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyMessageMock.mockResolvedValue(true)
  })

  it('verifies for an unconnected origin without opening Connect approval', async () => {
    const rpcFlow = (await import('../src/controllers/provider/rpcFlow')).default
    const request = {
      data: {
        method: 'verifyMessage',
        params: {
          address: 'qbrt1zaccount',
          text: 'hello',
          proof: { type: 'p2mr-message' },
        },
      },
      session: {
        origin: 'https://unconnected.example',
        name: 'Unconnected site',
        icon: '',
      },
    }

    await expect(rpcFlow(request)).resolves.toBe(true)

    expect(permissionServiceMock.hasPermission).not.toHaveBeenCalled()
    expect(approvalServiceMock.requestApproval).not.toHaveBeenCalled()
    expect(permissionServiceMock.addConnectedSite).not.toHaveBeenCalled()
    expect(verifyMessageMock).toHaveBeenCalledOnce()
    expect(verifyMessageMock).toHaveBeenCalledWith(expect.objectContaining({ data: request.data }))
  })
})
