/**
 * Reserved storage keys that must never supply website-safety policy.
 *
 * They are normalized during service initialization and are never read as
 * policy input. This module intentionally contains no network functionality.
 */
export const DISALLOWED_REMOTE_POLICY_KEYS = [
  'phishing',
  'phishing_list_fallback',
] as const
