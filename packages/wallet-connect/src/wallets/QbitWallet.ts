import type { P2mrMessageProof } from '@qbit-oss/protocol'
import type {
  Account,
  QbitBalance,
  QbitSignPsbtOptions,
  WalletConfig,
  WalletListenerParams,
} from '../types'
import { ALL_CHAIN_TYPES, ChainType, WalletType } from '../types'
import { sleep } from '../utils'
import { BaseWallet } from './BaseWallet'

const qbitProviderMethods = [
  'getAccounts',
  'requestAccounts',
  'getNetwork',
  'switchNetwork',
  'getChain',
  'switchChain',
  'getPublicKey',
  'getBalance',
  'signMessage',
  'verifyMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'sendQbit',
  'disconnect',
  'on',
  'removeListener',
] as const

// EIP-1193 Unauthorized: the provider's error for an origin without a grant
// on the wallet's active chain.
const UNAUTHORIZED = 4100

type QbitProviderMethod = (typeof qbitProviderMethods)[number]
type QbitProviderCandidate = Partial<Record<QbitProviderMethod, unknown>>

function isQbitProvider(provider: unknown): provider is NonNullable<typeof window.qbit> {
  if (!provider || typeof provider !== 'object') {
    return false
  }

  const candidate = provider as QbitProviderCandidate
  return qbitProviderMethods.every(method => typeof candidate[method] === 'function')
}

function isP2mrMessageProof(value: unknown): value is P2mrMessageProof {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<P2mrMessageProof>).type === 'p2mr-message'
  )
}

/**
 * Qbit Wallet implementation
 */
export class QbitWallet extends BaseWallet {
  readonly config: WalletConfig = {
    name: 'Qbit Wallet',
    icon: '',
    type: WalletType.Qbit,
    logoPadding: 4,
    supportChain: [ChainType.QBIT_TESTNET4, ChainType.QBIT_REGTEST, ChainType.QBIT_MAINNET],
  }

  private getProvider() {
    return isQbitProvider(window.qbit) ? window.qbit : undefined
  }

  async init(): Promise<void> {
    this.installed = !!this.getProvider()

    // Retry check for slow extension loading
    for (let i = 0; i < 10 && !this.installed; i += 1) {
      await sleep(100 + i * 100)
      this.installed = !!this.getProvider()
      if (this.installed) break
    }
  }

  async requestAccount(): Promise<Account | undefined> {
    const provider = this.getProvider()
    if (!this.installed || !provider) {
      this.showNotInstalledWarning()
      return undefined
    }

    // Connect first: switchChain needs this origin's grant, which
    // requestAccounts asks the user for on the wallet's active chain.
    const addresses = await provider.requestAccounts()
    if (this.chainType) {
      const connectedChain = await provider.getChain()
      if (connectedChain !== this.chainType) {
        // A separate switch the user approves; it moves the grant to the new
        // chain, whose account is then read like a connected one.
        await this.switchChainAfterConnect(provider, this.chainType, connectedChain)
        return this.getAccount()
      }
    }

    const publicKey = await provider.getPublicKey()
    const address = addresses[0]

    if (!address) {
      return undefined
    }

    return {
      address,
      pubKey: publicKey,
    }
  }

  async getAccount(): Promise<Account | undefined> {
    const provider = this.getProvider()
    if (!this.installed || !provider) return undefined

    const temp = await provider.getAccounts()
    if (!temp || temp.length <= 0) return undefined

    const currentChain = await provider.getChain()
    if (this.chainType && this.chainType !== currentChain) {
      // Network mismatch
      return undefined
    }

    const addresses = await provider.getAccounts()
    if (addresses[0]) {
      const publicKey = await provider.getPublicKey()
      return {
        address: addresses[0],
        pubKey: publicKey,
      }
    }

    return undefined
  }

  addListener(params: WalletListenerParams): void {
    const provider = this.getProvider()
    if (!provider) return
    provider.on('accountsChanged', params.onAccountChange)
    provider.on('networkChanged', params.onNetworkChange)
    if (params.onChainChange) {
      provider.on('chainChanged', params.onChainChange)
    }
    if (params.onDisconnect) {
      provider.on('disconnect', params.onDisconnect)
    }
  }

  removeListener(params: WalletListenerParams): void {
    const provider = this.getProvider()
    if (!provider) return
    provider.removeListener('accountsChanged', params.onAccountChange)
    provider.removeListener('networkChanged', params.onNetworkChange)
    if (params.onChainChange) {
      provider.removeListener('chainChanged', params.onChainChange)
    }
    if (params.onDisconnect) {
      provider.removeListener('disconnect', params.onDisconnect)
    }
  }

  async getBalance(): Promise<QbitBalance | null> {
    const provider = this.getProvider()
    if (!this.installed || !provider) {
      return { confirmed: 0, unconfirmed: 0, total: 0 }
    }
    await this.checkNetwork()
    return provider.getBalance()
  }

  /**
   * Check and switch network if needed
   */
  async checkNetwork(): Promise<boolean> {
    const provider = this.getProvider()
    if (!provider || !this.chainType) return false

    const currentChain = await provider.getChain()
    if (this.chainType !== currentChain) {
      await provider.switchChain(this.chainType)
      return false
    }
    return true
  }

  async signPsbt(psbt: string): Promise<string> {
    const provider = this.getProvider()
    if (!provider) {
      throw new Error(this.t('walletNotConnected', 'Wallet not connected'))
    }

    const chain = await this.prepareSigningChain(provider)

    const params: QbitSignPsbtOptions = {
      chain,
      autoFinalized: false,
    }
    return provider.signPsbt(psbt, params)
  }

  async signPsbts(params: { psbt: string }[]): Promise<string[]> {
    const provider = this.getProvider()
    if (!provider) {
      throw new Error(this.t('walletNotConnected', 'Wallet not connected'))
    }

    const chain = await this.prepareSigningChain(provider)

    const opts = params.map(() => {
      const opt: QbitSignPsbtOptions = {
        chain,
        autoFinalized: false,
      }
      return opt
    })

    return provider.signPsbts(
      params.map(item => item.psbt),
      opts
    )
  }

  async signMessage(message: string): Promise<P2mrMessageProof> {
    const provider = this.getProvider()
    if (!provider) {
      throw new Error(this.t('walletNotConnected', 'Wallet not connected'))
    }
    await this.prepareSigningChain(provider)
    const proof = await provider.signMessage(message)
    if (!isP2mrMessageProof(proof)) {
      throw new Error(
        this.t('invalidMessageProof', 'Wallet returned an invalid P2MR message proof')
      )
    }
    return proof
  }

  async verifyMessage(address: string, message: string, proof: P2mrMessageProof): Promise<boolean> {
    const provider = this.getProvider()
    if (!provider) {
      throw new Error(this.t('walletNotConnected', 'Wallet not connected'))
    }
    return provider.verifyMessage(address, message, proof)
  }

  /**
   * Revoke this origin's grant in Qbit Wallet. Call it only for an explicit
   * user disconnect: accountsChanged [] also means the wallet is on a chain
   * this origin has no grant for, and revoking then would drop the grant.
   */
  async disconnect(): Promise<void> {
    const provider = this.getProvider()
    if (!provider) {
      throw new Error(this.t('walletNotConnected', 'Wallet not connected'))
    }
    await provider.disconnect()
  }

  /**
   * Switch an origin connected on `connectedChain` to `chain`. A 4100 means
   * the origin has no grant on the wallet's active chain. When the active
   * chain changed after it connected, connect on that chain, then switch
   * once more. On the same chain, the user revoked the grant, which stands.
   */
  private async switchChainAfterConnect(
    provider: NonNullable<typeof window.qbit>,
    chain: ChainType,
    connectedChain: ChainType
  ): Promise<void> {
    try {
      await provider.switchChain(chain)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== UNAUTHORIZED) throw error
      if ((await provider.getChain()) === connectedChain) throw error
      await provider.requestAccounts()
      await provider.switchChain(chain)
    }
  }

  private async prepareSigningChain(provider: NonNullable<typeof window.qbit>): Promise<ChainType> {
    if (this.chainType) {
      await this.checkNetwork()
      return this.chainType
    }

    const chain = await provider.getChain()
    if (!ALL_CHAIN_TYPES.includes(chain)) {
      throw new Error(this.t('unsupportedQbitChain', 'Unsupported Qbit chain'))
    }
    return chain
  }
}
