/**
 * Compute the full BIP32 derivation path for a given account index.
 *
 * Address-index mode:
 *   hdPath = "m/84'/0'/0'/0", accountIndex = 2  →  "m/84'/0'/0'/0/2"
 *
 * Account-index mode:
 *   hdPath = "m/84'/0'/0'/0", accountIndex = 2  →  "m/84'/0'/2'/0/0"
 *   The account segment (index 3) is incremented; address index is fixed at 0.
 */
export function getAccountDerivationPath(
  hdPath: string,
  accountIndex: number,
  accountIndexDerivation = false
): string {
  if (accountIndexDerivation) {
    const segments = hdPath.split('/')
    if (segments.length < 4) {
      throw new Error(`Invalid hdPath for account-index derivation: ${hdPath}`)
    }
    segments[3] = `${accountIndex}'`
    return segments.join('/') + '/0'
  }
  return hdPath + '/' + accountIndex
}
