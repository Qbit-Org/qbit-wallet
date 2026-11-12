import type { WalletController } from './wallet'

/**
 * The `chrome.runtime.MessageSender` fields `isExtensionPageSender` reads,
 * declared structurally so the published types don't need `@types/chrome`.
 */
export interface ExtensionMessageSender {
  id?: string | undefined
  url?: string | undefined
  origin?: string | undefined
  frameId?: number | undefined
}

/**
 * Whether a port or runtime message comes from one of this extension's own
 * pages (popup, notification window, tab, side panel, phishing warning).
 *
 * Content scripts carry the extension's id too and can name a port anything,
 * so neither proves the sender is wallet UI. The sender's document must be
 * served from the extension's own origin. The browser fills in `url` and
 * `origin` from the frame that sent the message; the sender cannot choose them.
 * It also has to be a top-level document, so that a site cannot frame a
 * wallet page and click-jack it: the manifest makes `phishing-warning.html`
 * web-accessible to every site, under a per-session dynamic URL.
 */
export function isExtensionPageSender(sender: ExtensionMessageSender | undefined): boolean {
  const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime
  if (!runtime?.id || sender?.id !== runtime.id) return false
  // `frameId` is only reported for senders in a tab; 0 is the top frame.
  if (sender.frameId !== undefined && sender.frameId !== 0) return false

  const extensionOrigin = originOf(runtime.getURL(''))
  if (!extensionOrigin || originOf(sender.url) !== extensionOrigin) return false
  // Chromium also reports the frame's origin (Firefox does not); when it is
  // there it has to agree with the URL.
  return sender.origin === undefined || sender.origin === extensionOrigin
}

// Built from scheme and host because `URL.origin` is "null" for non-special
// schemes such as chrome-extension: outside Chromium, and "null" must never
// match.
function originOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const { protocol, host } = new URL(url)
    return host ? `${protocol}//${host}` : undefined
  } catch {
    return undefined
  }
}

/**
 * The controller methods the wallet's own pages may call over a UI port: what
 * the extension UI and @qbit/wallet-state call as `wallet.<method>`, plus the
 * reads the e2e harness makes. Every other member, TypeScript-private and
 * inherited ones included, stays out of reach. `test/ui-access.test.ts`
 * checks this list against the UI sources.
 */
export const UI_CONTROLLER_METHODS = [
  'abandonQbitSendBroadcastClaim',
  'acknowledgeQbitRecoveryRisk',
  'acknowledgeRegtestAccess',
  'addAddressFlag',
  'addContact',
  'advanceQbitRecoveryMigration',
  'analyzeLocalPsbts',
  'beginQbitRecoveryMigrationToExistingDestination',
  'boot',
  'broadcastQbitTx',
  'cancelQbitSendPlan',
  'changeAddressType',
  'changeKeyring',
  'changePassword',
  'checkQbitBroadcastStatus',
  'checkWebsite',
  'clearBiometricUnlock',
  'confirmQbitRestoredFloorSigning',
  'continueQbitSendPlan',
  'createBumpFeeQbitPsbt',
  'createDummyPsbt',
  'createKeyringWithAddress',
  'createKeyringWithColdWallet',
  'createKeyringWithMnemonics',
  'createKeyringWithPublicKey',
  'createQbitConsolidationPsbt',
  'createQbitReceiveIntent',
  'createQbitRecoveryMigrationWallet',
  'createSendAllQbitPsbt',
  'createSendQbitPsbt',
  'createTmpKeyringWithAddress',
  'createTmpKeyringWithMnemonics',
  'createTmpKeyringWithPublicKey',
  'decodePsbt',
  'deriveAccountsFromXpub',
  'deriveNewAccountFromMnemonic',
  'disableRegtestAccess',
  'dismissQbitRecoveryWarning',
  'dismissQbitSendPlan',
  'ensureQbitReceiveIntent',
  'exportP2mrDescriptors',
  'generatePreMnemonic',
  'getAccounts',
  'getAddressBalance',
  'getAddressBalanceV2',
  'getAddressHistory',
  'getAddressSummary',
  'getAllAddresses',
  'getApproval',
  'getAutoLockTimeId',
  'getBackgroundStartupStatus',
  'getBiometricUnlockRecord',
  'getBiometricUnlockStatus',
  'getChainType',
  'getConnectedSites',
  'getContactByAddressAndChain',
  'getCurrentAccount',
  'getCurrentConnectedSite',
  'getCurrentKeyring',
  'getDeveloperMode',
  'getEnableRBF',
  'getFeeSummary',
  'getIsFirstOpen',
  'getKeyrings',
  'getLocale',
  'getLockOnComputerLock',
  'getLockOnWindowsClosed',
  'getLowFeeSummary',
  'getMnemonics',
  'getMultiAddressSummaries',
  'getNetworkType',
  'getNextAlianName',
  'getPrivateKey',
  'getQbitConcurrentInstanceHint',
  'getQbitConsolidationStatus',
  'getQbitFeeBumpEligibility',
  'getQbitRawTransactionHex',
  'getQbitReceiveState', // e2e harness
  'getQbitRecoveryState',
  'getQbitRestoreFloorsPending',
  'getQbitSendPlan',
  'getQbitTxLifecycleStatus',
  'getQbitUtxoSnapshot',
  'abandonQbitUtxoSnapshot',
  'getQbitUtxos', // e2e harness
  'getRegtestAccessStatus',
  'getSkippedVersion',
  'getThemeMode',
  'getVersionDetail',
  'getWalletConfig',
  'getWalletId',
  'hasVault',
  'isBooted',
  'isReady',
  'isUnlocked',
  'listContacts',
  'lockWallet',
  'prepareQbitRecoveryMigration',
  'prepareQbitSendPlan',
  'rejectApproval',
  'releaseQbitRestoredFloorSigningChallenges',
  'releaseQbitSendBroadcastClaim',
  'removeAddressFlag',
  'removeConnectedSite',
  'removeContact',
  'removeKeyring',
  'replaceContact',
  'reserveExternallySignedQbitSend',
  'resetWallet',
  'resolveApproval',
  'resolveUnlockApproval',
  'restoreQbitKeyringWithFloors',
  'runQbitRestoreFloorScan',
  'saveBiometricUnlockRecord',
  'saveContactsOrder',
  'setAccountAlianName',
  'setAutoLockTimeId',
  'setChainType',
  'setDeveloperMode',
  'setEnableRBF',
  'setKeyringAlianName',
  'setKeyringColor',
  'setLastActiveTime',
  'setLocale',
  'setLockOnComputerLock',
  'setLockOnWindowsClosed',
  'setOpenInSidePanel',
  'setSkippedVersion',
  'setThemeMode',
  'signLocalBatchPsbt',
  'signMessage',
  'signPsbtV2',
  'startQbitSendPlan',
  'unlock',
  'updateConnectSite',
  'updateContact',
  'verifyPassword',
  'verifyRegtestAccess',
] as const satisfies readonly (keyof WalletController)[]

const uiControllerMethods: ReadonlySet<string> = new Set(UI_CONTROLLER_METHODS)

/**
 * The UI controller methods a page's call to which runs while a reset runs,
 * where WalletController.runForUiPort holds every other until the reset has
 * ended: resetWallet, which queues behind the reset under way itself. Each
 * must be one of UI_CONTROLLER_METHODS, so renaming a method keeps it here.
 */
export const UI_METHODS_RUN_DURING_RESET = [
  'resetWallet',
] as const satisfies readonly (typeof UI_CONTROLLER_METHODS)[number][]

const uiMethodsRunDuringReset: ReadonlySet<string> = new Set(UI_METHODS_RUN_DURING_RESET)

/** Whether a page's call to `method` runs while a reset runs; see UI_METHODS_RUN_DURING_RESET. */
export function runsDuringWalletReset(method: string): boolean {
  return uiMethodsRunDuringReset.has(method)
}

/**
 * Resolve a UI-port request to the controller method it names. Throws unless
 * the name is allowlisted and the controller itself holds a function under
 * it, as an instance property or a method of its own class, so nothing
 * inherited (from Object.prototype or a base class) is ever called.
 */
export function getUiControllerMethod(
  controller: object,
  method: unknown
): (...params: unknown[]) => unknown {
  if (typeof method === 'string' && uiControllerMethods.has(method)) {
    const prototype: object | null = Object.getPrototypeOf(controller)
    const own =
      Object.prototype.hasOwnProperty.call(controller, method) ||
      (prototype !== null && Object.prototype.hasOwnProperty.call(prototype, method))
    const fn: unknown = own ? (controller as Record<string, unknown>)[method] : undefined
    if (typeof fn === 'function') {
      return fn.bind(controller)
    }
  }
  throw new Error(`Unknown wallet method: ${String(method)}`)
}
