import { t } from '../utils/i18n'

export enum ErrorCodes {
  UNKNOWN = -1,
  INSUFFICIENT_QBIT_UTXO = -2,
  INSUFFICIENT_FEE_UTXO = -7,
  NO_ACCOUNT = -8,
  // Recovery migration source holds protected data that a sweep would
  // destroy; it must be moved separately.
  QBIT_RECOVERY_PROTECTED_ASSETS = -9,
  // The destination wallet a prior network's migration recorded no longer
  // resolves; the caller may fall back to creating a fresh destination.
  QBIT_RECOVERY_DESTINATION_UNAVAILABLE = -10,
  // Removing this wallet touches an active recovery migration; the UI must
  // collect an explicit risk confirmation and retry with the acknowledgement
  // option. Never a hard block.
  QBIT_RECOVERY_REMOVAL_ACK_REQUIRED = -11,
  // Local regtest is gated behind the optional loopback host permission plus
  // the in-app acknowledgement; neither is present (or was revoked).
  REGTEST_ACCESS_LOCKED = -12,
  // Permission and acknowledgement exist but nothing answered at the fixed
  // loopback origin within the probe bounds.
  REGTEST_SERVICE_UNREACHABLE = -13,
  // Something answered at the loopback origin but it is not the Qbit regtest
  // API (wrong genesis, redirect, malformed or oversized response, ...).
  REGTEST_SERVICE_UNEXPECTED = -14,
  // A security setting's change failed to save and so did the previous value
  // put back in its place: the stored setting may hold either value until a
  // later save succeeds.
  PREFERENCE_NOT_RESTORED = -15,
  // A provider sendQbit, pushTx or pushPsbt broadcast ended without a
  // verdict: the transaction named in the error data may be in the mempool,
  // so the dapp must check it before retrying. A sendQbit's inputs stay
  // reserved, and a push's when the user approved signing that transaction
  // for a dapp. The code is in the JSON-RPC implementation-defined server
  // error range (-32000 to -32099, clear of EIP-1474's -32000 to -32005)
  // because the page provider's serializer replaces any other unknown code
  // with -32603 and drops the data.
  QBIT_BROADCAST_OUTCOME_UNKNOWN = -32010,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  UserCancel = 4001,
  UNAUTHORIZED = 4100,
  // The current Qbit network has no canonical deriveContextHash identifier.
  // EIP-1193 reserves 4901 for "Chain Disconnected", the closest standard analog.
  UNSUPPORTED_NETWORK = 4901,
}

export const ErrorMessages: {
  [key in ErrorCodes]?: string
} = {
  [ErrorCodes.UNKNOWN]: 'code_unknown_error',
  [ErrorCodes.INSUFFICIENT_QBIT_UTXO]: 'code_insufficient_balance',
  [ErrorCodes.INSUFFICIENT_FEE_UTXO]: 'code_insufficient_fee_utxo',
  [ErrorCodes.NO_ACCOUNT]: 'wallet_must_has_at_least_one_account',
  [ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS]: 'qbit_recovery_protected_assets_error',
  [ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED]: 'qbit_recovery_wallets_retained',
  [ErrorCodes.REGTEST_ACCESS_LOCKED]: 'regtest_access_not_enabled',
  [ErrorCodes.REGTEST_SERVICE_UNREACHABLE]: 'regtest_service_unavailable',
  [ErrorCodes.REGTEST_SERVICE_UNEXPECTED]: 'regtest_service_unexpected',
  [ErrorCodes.PREFERENCE_NOT_RESTORED]: 'setting_not_saved_may_have_changed',
  [ErrorCodes.METHOD_NOT_FOUND]: 'code_method_not_found',
  [ErrorCodes.INVALID_PARAMS]: 'Invalid provider request parameters',
  [ErrorCodes.UserCancel]: 'user_rejected_the_request',
  [ErrorCodes.UNAUTHORIZED]: 'Unauthorized provider request',
  [ErrorCodes.UNSUPPORTED_NETWORK]: 'code_unsupported_network',
}

export class WalletError extends Error {
  public code = ErrorCodes.UNKNOWN
  constructor(code: ErrorCodes, message?: string) {
    if (!message) {
      message = t(ErrorMessages[code] || 'Unknown error')
    }
    super(message)
    this.code = code
    Object.setPrototypeOf(this, WalletError.prototype)
  }
}
