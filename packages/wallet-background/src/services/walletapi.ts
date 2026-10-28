import { WalletApiService } from '@qbit/wallet-api'

// Create and export singleton instance
const walletApiService = new WalletApiService()

export { walletApiService }
export default walletApiService
