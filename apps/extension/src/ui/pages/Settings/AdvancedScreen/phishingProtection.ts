import {
  PhishingMessageType,
  type PhishingNetworkRuleHealth,
  type PhishingNetworkRuleStatus,
  type PhishingProtectionHealth,
  type PhishingProtectionReason,
  type PhishingProtectionStatus
} from '@qbit/wallet-shared';

/** What the Advanced settings row says about phishing protection. */
export type PhishingProtectionState =
  | 'protected'
  | 'starting'
  | 'retrying'
  | 'failed'
  | 'unsupported'
  | 'degraded'
  | 'unknown';

export interface PhishingProtectionView {
  state: PhishingProtectionState;
  /** The block rule as the background last read it; absent when the stats could not be read. */
  networkRules?: PhishingNetworkRuleHealth;
  /** Why protection is not full, as the background reports it. */
  reasons: PhishingProtectionReason[];
}

const NETWORK_RULE_STATUSES: ReadonlySet<PhishingNetworkRuleStatus> = new Set([
  'installing',
  'installed',
  'retrying',
  'failed',
  'unknown',
  'unsupported'
]);

const PROTECTION_STATUSES: ReadonlySet<PhishingProtectionStatus> = new Set(['full', 'degraded', 'unknown']);

export const PHISHING_PROTECTION_REASONS: readonly PhishingProtectionReason[] = [
  'block-rule-not-installed',
  'block-rule-unknown',
  'redirect-rule-without-host-access',
  'redirect-rule-unknown',
  'site-access-withheld',
  'site-access-unknown'
];

const UNKNOWN: PhishingProtectionView = { state: 'unknown', reasons: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseNetworkRules(value: unknown): PhishingNetworkRuleHealth | null {
  if (!isRecord(value)) return null;
  const { status, attempts, blockedDomains, skippedEntries, error, nextRetryAt, updatedAt } = value;
  if (
    !NETWORK_RULE_STATUSES.has(status as PhishingNetworkRuleStatus) ||
    !isCount(attempts) ||
    !(blockedDomains === null || isCount(blockedDomains)) ||
    !Array.isArray(skippedEntries) ||
    !(error === undefined || typeof error === 'string') ||
    !(nextRetryAt === undefined || isTime(nextRetryAt)) ||
    !isTime(updatedAt)
  ) {
    return null;
  }
  return value as unknown as PhishingNetworkRuleHealth;
}

function parseProtection(value: unknown): PhishingProtectionHealth | null {
  if (!isRecord(value)) return null;
  const { status, reasons, warningRedirect } = value;
  if (
    !PROTECTION_STATUSES.has(status as PhishingProtectionStatus) ||
    !Array.isArray(reasons) ||
    !reasons.every((reason) => PHISHING_PROTECTION_REASONS.includes(reason)) ||
    !isRecord(warningRedirect) ||
    typeof warningRedirect.status !== 'string'
  ) {
    return null;
  }
  return value as unknown as PhishingProtectionHealth;
}

/**
 * The row's state for a `GET_PHISHING_STATS` answer. Anything that is not a
 * well-formed answer reads as unknown, and only an installed block rule with
 * full protection reads as protected.
 */
export function describePhishingProtection(reply: unknown): PhishingProtectionView {
  if (!isRecord(reply)) return UNKNOWN;
  const networkRules = parseNetworkRules(reply.networkRules);
  if (!networkRules) return UNKNOWN;
  let protection: PhishingProtectionHealth | undefined;
  if (reply.protection !== undefined) {
    const parsed = parseProtection(reply.protection);
    if (!parsed) return UNKNOWN;
    protection = parsed;
  }
  const reasons = protection && protection.status !== 'full' ? protection.reasons : [];

  switch (networkRules.status) {
    case 'unsupported':
      return { state: 'unsupported', networkRules, reasons: [] };
    case 'installing':
      return { state: 'starting', networkRules, reasons };
    case 'retrying':
      return { state: 'retrying', networkRules, reasons };
    case 'failed':
      return { state: 'failed', networkRules, reasons };
    case 'unknown':
      return { state: 'unknown', networkRules, reasons };
    case 'installed':
      if (protection?.status === 'full') return { state: 'protected', networkRules, reasons: [] };
      if (protection?.status === 'degraded') return { state: 'degraded', networkRules, reasons };
      // Without the MV3 protection report an installed rule is not known to suffice.
      return { state: 'unknown', networkRules, reasons };
  }
}

/** Seconds until `nextRetryAt`, rounded up, or `'due'` once it has passed. */
export function secondsUntilRetry(nextRetryAt: number, now: number): number | 'due' {
  const seconds = Math.ceil((nextRetryAt - now) / 1000);
  return seconds > 0 ? seconds : 'due';
}

/** The background's error text without the `Error: ` that `String(error)` puts in front. */
export function plainError(error: string): string {
  return error.replace(/^Error:\s*/, '');
}

// How long the row waits for the background. The stats bound their own
// slowest part to 2 s, but a read can wait behind an install attempt.
export const PHISHING_STATS_TIMEOUT_MS = 10_000;
export const PHISHING_RETRY_TIMEOUT_MS = 30_000;

/** The background did not answer in time; what it did is not known. */
export class PhishingMessageTimeoutError extends Error {}

/**
 * Sends a phishing message to the background, the way the warning page does.
 * Rejects when the background cannot be reached, or does not answer within
 * `timeoutMs`.
 */
export function sendPhishingMessage(type: PhishingMessageType, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PhishingMessageTimeoutError()), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type }, (reply: unknown) => {
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || ''));
          return;
        }
        resolve(reply);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/** Reads the protection state. A failed read is unknown, never protected. */
export async function readPhishingProtection(): Promise<PhishingProtectionView> {
  try {
    return describePhishingProtection(
      await sendPhishingMessage(PhishingMessageType.GET_PHISHING_STATS, PHISHING_STATS_TIMEOUT_MS)
    );
  } catch {
    return UNKNOWN;
  }
}

/**
 * Asks the background to install the block rule again. Resolves only on an
 * explicit success; otherwise rejects, with the background's error as the
 * message when it gave one, or with a PhishingMessageTimeoutError.
 */
export async function retryPhishingProtection(): Promise<void> {
  const reply = await sendPhishingMessage(PhishingMessageType.FORCE_UPDATE_PHISHING_LIST, PHISHING_RETRY_TIMEOUT_MS);
  if (isRecord(reply) && reply.success === true) return;
  throw new Error(isRecord(reply) && typeof reply.error === 'string' ? plainError(reply.error) : '');
}
