// Settings earlier releases saved that this build drops when it loads them:
// the signData switch, and settings of the wallet this one was forked from
// that nothing reads.
export const DROPPED_KEYS: readonly string[] = [
  'enableSignData',
  'currency',
  'showSafeNotice',
  'acceptLowFeeMode',
  'guideReaded',
  'rateUsStatus',
  'walletSavedList',
  'editingKeyringIndex',
  'editingAccount',
  'uiCachedData',
  'addressSummary',
  'watchAddressPreference',
  'currentVersion',
]
