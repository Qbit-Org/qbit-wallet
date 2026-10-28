/**
 * Sleep utility function
 * @param ms Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert hex string to base64
 * @param hex Hex string
 */
export function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(
    hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

/**
 * Check if address is a qbit P2MR bech32m address by HRP/version prefix.
 */
export function isP2MRAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith('qb1z') || lower.startsWith('tq1z') || lower.startsWith('qbrt1z');
}

/**
 * Check if address is a supported qbit address type.
 */
export function isSupportedAddressType(address: string): boolean {
  return isP2MRAddress(address);
}
