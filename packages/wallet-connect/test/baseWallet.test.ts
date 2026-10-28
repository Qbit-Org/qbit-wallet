import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { P2mrMessageProof } from '@qbit-oss/protocol'

import { BaseWallet } from '../src/wallets/BaseWallet'
import { ChainType, WalletType, type WalletConfig } from '../src/types'

class DummyWallet extends BaseWallet {
  readonly config: WalletConfig = {
    name: 'Dummy',
    icon: 'dummy.svg',
    type: WalletType.Qbit,
    supportChain: [ChainType.QBIT_MAINNET],
    downloadUrl: 'https://example.com/download',
  }

  async init(): Promise<void> {}
  async requestAccount() {
    return undefined
  }
  async getAccount() {
    return undefined
  }
  addListener(): void {}
  removeListener(): void {}
  async getBalance() {
    return { confirmed: 0, unconfirmed: 0, total: 0 }
  }
  async signPsbt(): Promise<string> {
    return ''
  }
  async signPsbts(): Promise<string[]> {
    return []
  }
  async signMessage(): Promise<P2mrMessageProof> {
    return { type: 'p2mr-message' } as P2mrMessageProof
  }
  async verifyMessage(): Promise<boolean> {
    return true
  }
  async disconnect(): Promise<void> {}

  exposeTranslate(key: string, fallback: string) {
    return this.t(key, fallback)
  }

  exposeShowWarning() {
    this.showNotInstalledWarning()
  }
}

describe('BaseWallet', () => {
  beforeEach(() => {
    ;(globalThis as any).window = {
      open: vi.fn(),
    }
  })

  it('uses translator when provided and fallback otherwise', () => {
    const wallet = new DummyWallet()

    expect(wallet.exposeTranslate('k', 'fallback')).toBe('fallback')

    wallet.setTranslator(key => `translated:${key}`)
    expect(wallet.exposeTranslate('k2', 'fallback2')).toBe('translated:k2')
  })

  it('does not expose dedicated P2MR aliases', () => {
    const wallet = new DummyWallet()

    expect(wallet.signP2mrMessage).toBeUndefined()
    expect(wallet.verifyP2mrMessage).toBeUndefined()
    expect('signP2mrMessage' in wallet).toBe(false)
    expect('verifyP2mrMessage' in wallet).toBe(false)
  })

  it('uses the structured P2MR message contract', async () => {
    const wallet = new DummyWallet()

    await expect(wallet.signMessage('hello')).resolves.toEqual({ type: 'p2mr-message' })
    await expect(
      wallet.verifyMessage('qb1zaccount', 'hello', {} as P2mrMessageProof)
    ).resolves.toBe(true)
  })

  it('showNotInstalledWarning sends notification and opens download link on click', () => {
    const wallet = new DummyWallet()

    const warning = vi.fn()
    const destroy = vi.fn()

    wallet.setNotifier({ warning, destroy })
    wallet.exposeShowWarning()

    expect(warning).toHaveBeenCalledTimes(1)

    const payload = warning.mock.calls[0][0]
    expect(payload.message).toContain('Dummy not installed')

    payload.onClick()

    expect(destroy).toHaveBeenCalledTimes(1)
    expect((globalThis as any).window.open).toHaveBeenCalledWith(
      'https://example.com/download',
      '_blank'
    )
  })
})
