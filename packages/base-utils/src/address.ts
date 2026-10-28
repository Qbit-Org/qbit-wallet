const BECH32_REGEX = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/

/**
 * Validate if a qbit P2MR address is likely valid.
 * This is a lightweight check, NOT a full validation with checksum.
 *
 * qbit P2MR addresses use bech32m witness v2 with qb/tq/qbrt HRPs.
 *
 * @param address - qbit address to validate
 * @returns true if address format looks valid, false otherwise
 */
export function isAddressLikelyValid(address: string): boolean {
  if (!address) return false

  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    return false
  }

  const lower = address.toLowerCase()

  if (lower.startsWith('qb1z') || lower.startsWith('tq1z') || lower.startsWith('qbrt1z')) {
    if (lower.length < 62 || lower.length > 64) return false
    const separator = lower.lastIndexOf('1')
    return separator > 0 && BECH32_REGEX.test(lower.slice(separator + 1))
  }

  return false
}

export const addressUtils = {
  isAddressLikelyValid,
}
