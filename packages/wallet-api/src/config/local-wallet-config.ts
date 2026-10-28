import type { WalletConfig } from '@qbit/wallet-shared'

/**
 * Release-owned wallet configuration.
 *
 * Security-sensitive behavior must change through a reviewed extension release,
 * never through a chain-routed response.
 */
const LOCAL_WALLET_CONFIG: Readonly<WalletConfig> = Object.freeze({
  version: '',
  moonPayEnabled: false,
  statusMessage: '',
  endpoint: '',
  chainTip: '',
  disableUtxoTools: true,
})

export function getLocalWalletConfig(): WalletConfig {
  return { ...LOCAL_WALLET_CONFIG }
}
