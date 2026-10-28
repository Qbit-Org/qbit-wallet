import type {
  Account,
  QbitBalance,
  WalletConfig,
  WalletTranslator,
  WalletNotifier,
  WalletListenerParams,
  ChainType,
} from '../types'
import type { P2mrMessageProof } from '@qbit-oss/protocol'

/**
 * Abstract base class for wallet implementations
 * Extend this class to add support for new wallet types
 */
export abstract class BaseWallet {
  /** Whether the wallet extension is installed */
  installed = false

  /** Optional translator for i18n */
  protected translator?: WalletTranslator

  /** Optional notifier for UI feedback */
  protected notifier?: WalletNotifier

  /** Current chain type */
  protected chainType?: ChainType

  /** Wallet configuration */
  abstract readonly config: WalletConfig

  /**
   * Initialize the wallet - check if extension is installed
   */
  abstract init(): Promise<void>

  /**
   * Set translator for i18n support
   */
  setTranslator(translator: WalletTranslator): void {
    this.translator = translator
  }

  /**
   * Set notifier for UI feedback
   */
  setNotifier(notifier: WalletNotifier): void {
    this.notifier = notifier
  }

  /**
   * Set current chain type
   */
  setChainType(chainType: ChainType): void {
    this.chainType = chainType
  }

  /**
   * Translate a message with optional fallback
   */
  protected t(key: string, fallback: string, values?: Record<string, unknown>): string {
    if (this.translator) {
      return this.translator(key, values)
    }
    return fallback
  }

  /**
   * Show a warning notification
   */
  protected showNotInstalledWarning(): void {
    if (!this.notifier) return

    const key = `open${Date.now()}`
    this.notifier.warning({
      message: this.t('notInstalled', `${this.config.name} not installed`, {
        wallet: this.config.name,
      }),
      description: this.t(
        'visitProductPage',
        'Please click here to visit the product page. After installing the extension, please refresh the page.'
      ),
      key,
      onClick: () => {
        this.notifier?.destroy(key)
        if (this.config.downloadUrl) {
          window.open(this.config.downloadUrl, '_blank')
        }
      },
    })
  }

  /**
   * Request account connection from wallet
   */
  abstract requestAccount(): Promise<Account | undefined>

  /**
   * Get currently connected account
   */
  abstract getAccount(): Promise<Account | undefined>

  /** Add event listeners for account, network, chain, and disconnect changes. */
  abstract addListener(params: WalletListenerParams): void

  /**
   * Remove event listeners
   */
  abstract removeListener(params: WalletListenerParams): void

  /**
   * Get wallet balance
   */
  abstract getBalance(): Promise<QbitBalance | null>

  /**
   * Sign a single PSBT
   */
  abstract signPsbt(psbt: string): Promise<string>

  /**
   * Sign multiple PSBTs
   */
  abstract signPsbts(params: { psbt: string }[]): Promise<string[]>

  /** Sign a message with the Qbit P2MR scheme. */
  abstract signMessage(message: string): Promise<P2mrMessageProof>

  /** Verify a Qbit P2MR message proof without requesting approval. */
  abstract verifyMessage(
    address: string,
    message: string,
    proof: P2mrMessageProof
  ): Promise<boolean>

  /**
   * Disconnect from wallet
   */
  abstract disconnect(): Promise<void>
}
