/**
 * Whether `output` is the account's own: it carries a scriptPubKey, and that
 * scriptPubKey is `accountScriptPubKey`. An output without one is never
 * taken for the account's, whatever it claims otherwise; send builders
 * refuse it, and balances and the send screen leave it out.
 *
 * Without `accountScriptPubKey` (an account the wallet holds no script for,
 * or an address read for its own outputs) an output still counts only when
 * it carries a scriptPubKey.
 */
export function isQbitAccountOutput(
  output: { scriptPk?: string | null },
  accountScriptPubKey: string | undefined
): boolean {
  const { scriptPk } = output
  if (typeof scriptPk !== 'string' || scriptPk.length === 0) return false
  return (
    accountScriptPubKey === undefined ||
    scriptPk.toLowerCase() === accountScriptPubKey.toLowerCase()
  )
}
