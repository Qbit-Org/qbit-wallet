// Builds the support report shown behind the migration error screen's
// details toggle. Every failure renders the same localized message, so the
// report carries what that message cannot: which call failed, the
// background's own wording and a short code a user can paste on its own.

// The wallet call that failed. Each step maps to one background entry point,
// which narrows a pasted code to a single code path.
export type QbitRecoveryErrorStep =
  | 'source' // the screen opened without a valid source wallet
  | 'load' // getQbitRecoveryState on first load
  | 'begin' // beginQbitRecoveryMigrationToExistingDestination
  | 'create' // createQbitRecoveryMigrationWallet, then its state re-check
  | 'advance' // advanceQbitRecoveryMigration (status checks and broadcast)
  | 'prepare'; // prepareQbitRecoveryMigration (UTXO lookups and plan build)

const STEP_CODES: Record<QbitRecoveryErrorStep, string> = {
  source: 'SRC',
  load: 'LOAD',
  begin: 'BEGIN',
  create: 'CREATE',
  advance: 'ADV',
  prepare: 'PREP'
};

export interface QbitRecoveryErrorReport {
  code: string;
  step: QbitRecoveryErrorStep;
  message: string;
  walletErrorCode?: number;
  network?: string;
  version?: string;
  occurredAt: string;
}

// Txids, pubkeys and addresses are long unbroken runs of letters and digits.
const LONG_TOKEN = /[A-Za-z0-9]{20,}/g;

// Shortens identifiers so a pasted report does not publish full addresses or
// txids, while keeping enough of each to match it against logs.
export function redactQbitRecoveryErrorMessage(message: string): string {
  return message.replace(LONG_TOKEN, (token) => `${token.slice(0, 6)}…${token.slice(-4)}`);
}

// Standalone numbers such as array, input and account indexes. HTTP statuses
// ("HTTP 429", "Network request failed: 429") and RPC error codes are
// captured by the prefix so they stay in the hash: a 429 and a 500 are
// different failures.
const STANDALONE_NUMBER = /(HTTP |RPC error -?|request failed: )?\b\d+\b/g;

// The same failure produces the same fingerprint for every user and wallet:
// identifiers and indexes are blanked before hashing.
export function qbitRecoveryErrorFingerprint(message: string): string {
  const normalized = message
    .replace(LONG_TOKEN, '#')
    .replace(STANDALONE_NUMBER, (match, prefix?: string) => (prefix ? match : '#'))
    .trim();
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Errors cross the background→UI port as plain { message, code?, data? }
// objects, so both Error instances and those objects are read here.
function readError(error: unknown): { message: string; walletErrorCode?: number } {
  if (typeof error === 'string') return { message: error };
  if (!error || typeof error !== 'object') return { message: String(error) };
  const { message, code } = error as { message?: unknown; code?: unknown };
  return {
    message: typeof message === 'string' && message.trim() ? message : 'Unknown error',
    walletErrorCode: typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined
  };
}

export function buildQbitRecoveryErrorReport(
  step: QbitRecoveryErrorStep,
  error: unknown,
  context: { network?: string; version?: string; now?: Date } = {}
): QbitRecoveryErrorReport {
  const { message, walletErrorCode } = readError(error);
  return {
    code: `QRM-${STEP_CODES[step]}-${qbitRecoveryErrorFingerprint(message)}`,
    step,
    message: redactQbitRecoveryErrorMessage(message),
    walletErrorCode,
    network: context.network,
    version: context.version,
    occurredAt: (context.now ?? new Date()).toISOString()
  };
}

// Plain English on purpose: this text is read by developers, not the user.
export function formatQbitRecoveryErrorReport(report: QbitRecoveryErrorReport): string {
  return [
    `Qbit Wallet migration error ${report.code}`,
    `Step: ${report.step}`,
    `Message: ${report.message}`,
    report.walletErrorCode === undefined ? undefined : `Wallet error code: ${report.walletErrorCode}`,
    report.network ? `Network: ${report.network}` : undefined,
    report.version ? `Version: ${report.version}` : undefined,
    `Time: ${report.occurredAt}`
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
