// Provider controller for handling RPC requests
import { ErrorCodes, WalletError } from '@qbit/wallet-shared'
import { keyringService } from '../../services'
import internalMethod from './internalMethod'
import { ProviderMethodArgs, isInternalProviderMethod, isPublicProviderMethod } from './methodList'
import rpcFlow from './rpcFlow'

const METHODS_WITHOUT_VAULT = new Set([
  'getAccounts',
  'getNetwork',
  'getChain',
  'verifyMessage',
  'disconnect',
])

class ProviderController {
  async handleRequest(req: {
    source: 'page' | 'content'
    session: {
      origin: string
      icon: string
      name: string
    }
    data: ProviderMethodArgs | { method: string; params?: unknown }
    port?: unknown
  }) {
    const {
      data: { method },
    } = req

    if (!method) {
      throw new WalletError(ErrorCodes.METHOD_NOT_FOUND, 'Missing method in request')
    }

    if (req.source === 'content') {
      if (!isInternalProviderMethod(method)) {
        throw new WalletError(ErrorCodes.METHOD_NOT_FOUND, 'Unsupported internal method')
      }
      return internalMethod[method](req as never)
    }

    if (req.source !== 'page' || !isPublicProviderMethod(method)) {
      throw new WalletError(ErrorCodes.METHOD_NOT_FOUND, `Method [${String(method)}] not found`)
    }

    if (!req.session.origin) {
      throw new WalletError(ErrorCodes.UNAUTHORIZED, 'Provider session is not initialized')
    }

    const hasVault = keyringService.hasVault()
    if (!hasVault && !METHODS_WITHOUT_VAULT.has(method)) {
      throw new WalletError(ErrorCodes.NO_ACCOUNT, 'wallet must has at least one account')
    }
    return rpcFlow(req)
  }
}

export default new ProviderController()
