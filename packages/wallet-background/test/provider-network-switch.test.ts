import 'reflect-metadata'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

const walletMock = vi.hoisted(() => ({
  getChainType: vi.fn(),
  getCurrentAccount: vi.fn(),
  setChainType: vi.fn(),
  switchProviderChain: vi.fn(),
}))
const permissionServiceMock = vi.hoisted(() => ({
  updateConnectSite: vi.fn(),
}))
const sessionServiceMock = vi.hoisted(() => ({
  broadcastEvent: vi.fn(),
}))
const regtestAccessMock = vi.hoisted(() => ({
  assertAvailable: vi.fn(),
}))

vi.mock('../src/controllers/wallet', () => ({
  default: walletMock,
}))

vi.mock('../src/services', () => ({
  permissionService: permissionServiceMock,
  sessionService: sessionServiceMock,
}))

vi.mock('../src/services/regtestAccess', () => ({
  default: regtestAccessMock,
}))

describe('ProviderController network switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    walletMock.getChainType.mockReturnValue(ChainType.QBIT_TESTNET4)
    walletMock.getCurrentAccount.mockResolvedValue({ address: 'qbrt1zaccount' })
    walletMock.setChainType.mockResolvedValue(undefined)
    walletMock.switchProviderChain.mockResolvedValue(undefined)
    permissionServiceMock.updateConnectSite.mockResolvedValue(undefined)
    regtestAccessMock.assertAvailable.mockResolvedValue(undefined)
  })

  it('switches to qbit mainnet through switchChain', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const request = {
      data: {
        params: {
          chain: ChainType.QBIT_MAINNET,
        },
      },
      session: { origin: 'https://dapp.example' },
    }
    const [, validateSwitch] = Reflect.getMetadata('APPROVAL', provider, 'switchChain')

    await expect(validateSwitch(request)).resolves.toBe(false)
    await expect(provider.switchChain(request as any)).resolves.toBeUndefined()

    // The grant moves inside the wallet's queued chain switch, before any
    // event is published, not in a second step afterwards.
    expect(walletMock.switchProviderChain).toHaveBeenCalledWith(
      'https://dapp.example',
      ChainType.QBIT_MAINNET
    )
    expect(walletMock.setChainType).not.toHaveBeenCalled()
    expect(permissionServiceMock.updateConnectSite).not.toHaveBeenCalled()
    expect(sessionServiceMock.broadcastEvent).not.toHaveBeenCalled()
  })

  it('allows switching to regtest once the background capability reports it available', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const request = {
      data: {
        params: {
          network: 'regtest',
        },
      },
      session: { origin: 'https://dapp.example' },
    }
    const [, validateSwitch] = Reflect.getMetadata('APPROVAL', provider, 'switchNetwork')

    await expect(validateSwitch(request)).resolves.toBe(false)
    await expect(provider.switchNetwork(request as any)).resolves.toBeUndefined()
    expect(regtestAccessMock.assertAvailable).toHaveBeenCalled()
    expect(walletMock.switchProviderChain).toHaveBeenCalledWith(
      'https://dapp.example',
      ChainType.QBIT_REGTEST
    )
  })

  it('rejects a dapp regtest switch while the capability is locked, before any approval or prompt', async () => {
    const { ErrorCodes, WalletError } = await import('@qbit/wallet-shared')
    const provider = (await import('../src/controllers/provider/controller')).default
    regtestAccessMock.assertAvailable.mockRejectedValue(
      new WalletError(ErrorCodes.REGTEST_ACCESS_LOCKED, 'Regtest access has not been enabled')
    )

    const chainRequest = {
      data: {
        params: {
          chain: ChainType.QBIT_REGTEST,
        },
      },
      session: { origin: 'https://dapp.example' },
    }
    const [, validateChainSwitch] = Reflect.getMetadata('APPROVAL', provider, 'switchChain')
    await expect(validateChainSwitch(chainRequest)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
      message: 'Regtest access has not been enabled',
    })
    await expect(provider.switchChain(chainRequest as any)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })

    const networkRequest = {
      data: {
        params: {
          network: 'regtest',
        },
      },
      session: { origin: 'https://dapp.example' },
    }
    const [, validateNetworkSwitch] = Reflect.getMetadata('APPROVAL', provider, 'switchNetwork')
    await expect(validateNetworkSwitch(networkRequest)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
    await expect(provider.switchNetwork(networkRequest as any)).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })

    expect(walletMock.switchProviderChain).not.toHaveBeenCalled()
    expect(permissionServiceMock.updateConnectSite).not.toHaveBeenCalled()
    // The dapp path only ever consults the guard; nothing here can open a
    // browser permission prompt.
    expect(Object.keys(regtestAccessMock)).toEqual(['assertAvailable'])
  })

  it('surfaces an unreachable or unexpected local service as a distinct stable error', async () => {
    const { ErrorCodes, WalletError } = await import('@qbit/wallet-shared')
    const provider = (await import('../src/controllers/provider/controller')).default
    const request = {
      data: { params: { chain: ChainType.QBIT_REGTEST } },
      session: { origin: 'https://dapp.example' },
    }
    for (const code of [
      ErrorCodes.REGTEST_SERVICE_UNREACHABLE,
      ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    ]) {
      regtestAccessMock.assertAvailable.mockRejectedValueOnce(new WalletError(code, 'x'))
      await expect(provider.switchChain(request as any)).rejects.toMatchObject({ code })
    }
    expect(walletMock.switchProviderChain).not.toHaveBeenCalled()
  })

  it('does not consult the regtest capability for public networks', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const request = {
      data: { params: { network: 'testnet4' } },
      session: { origin: 'https://dapp.example' },
    }
    await expect(provider.switchNetwork(request as any)).resolves.toBeUndefined()
    expect(regtestAccessMock.assertAvailable).not.toHaveBeenCalled()
    expect(walletMock.switchProviderChain).toHaveBeenCalledWith(
      'https://dapp.example',
      ChainType.QBIT_TESTNET4
    )
  })

  it('rejects unsupported network names before switching', async () => {
    const provider = (await import('../src/controllers/provider/controller')).default
    const request = {
      data: {
        params: {
          network: 'livenet',
        },
      },
      session: { origin: 'https://dapp.example' },
    }
    const [, validateSwitch] = Reflect.getMetadata('APPROVAL', provider, 'switchNetwork')

    await expect(validateSwitch(request)).rejects.toThrow('unsupported Qbit network')
    await expect(provider.switchNetwork(request as any)).rejects.toThrow('unsupported Qbit network')
    expect(walletMock.switchProviderChain).not.toHaveBeenCalled()
  })
})
