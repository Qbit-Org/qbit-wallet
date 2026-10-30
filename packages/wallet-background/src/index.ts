/**
 * Qbit Wallet background exports.
 */

// Cross-platform adapters
export * from './adapters'

// Controllers
export { phishingController, providerController, walletController } from './controllers'
export {
  UI_CONTROLLER_METHODS,
  getUiControllerMethod,
  isExtensionPageSender,
  type ExtensionMessageSender,
} from './controllers/ui-access'
export { type ProviderMethodArgs, type ProviderMethods } from './controllers/provider/methodList'

// Services
export {
  approvalService,
  biometricUnlockService,
  contactBookService,
  keyringService,
  notificationService,
  permissionService,
  phishingDetectService,
  preferenceService,
  qbitSendGuardService,
  regtestAccessService,
  sessionService,
  walletApiService,
  type RegtestAccessAckStore,
  type RegtestAccessAdapter,
} from './services'

// webapi
export { notification } from './webapi'

// Utils
export { bgEventBus } from './utils/eventBus'

export {
  verifyRegtestService,
  type RegtestFetch,
  type RegtestServiceVerification,
} from './utils/regtest-service-verification'
