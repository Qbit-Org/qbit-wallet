/**
 * Wallet colors. A wallet stores one of these palette keys, never a color
 * value: the UI maps each key to a light-mode and a dark-mode color.
 *
 * A wallet with no stored color shows the key of its slot, so the order and
 * the number of keys decide what those wallets look like. Add keys only at
 * the end, and never rename or remove one, or stored colors stop resolving.
 */
export const WALLET_COLOR_KEYS = [
  'green',
  'blue',
  'orange',
  'violet',
  'teal',
  'pink',
  'gold',
  'indigo',
] as const

export type WalletColorKey = (typeof WALLET_COLOR_KEYS)[number]

const walletColorKeys: ReadonlySet<string> = new Set(WALLET_COLOR_KEYS)

/** Whether `value` is one of the palette keys. */
export function isWalletColorKey(value: unknown): value is WalletColorKey {
  return typeof value === 'string' && walletColorKeys.has(value)
}

/**
 * The palette key of a wallet slot (`WalletKeyring.index`), wrapping around
 * the palette. A value that is not a slot index, such as the -1 of a wallet
 * that is not added yet, gets the first key.
 */
export function walletColorForSlot(slotIndex: number): WalletColorKey {
  const position =
    Number.isSafeInteger(slotIndex) && slotIndex >= 0 ? slotIndex % WALLET_COLOR_KEYS.length : 0
  return WALLET_COLOR_KEYS[position] ?? WALLET_COLOR_KEYS[0]
}

/** The stored palette key, or the slot's key when no valid key is stored. */
export function resolveWalletColor(stored: unknown, slotIndex: number): WalletColorKey {
  return isWalletColorKey(stored) ? stored : walletColorForSlot(slotIndex)
}

/** How names compare when checking whether a number is used. */
function comparableWalletName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The default name of a wallet: "Wallet N", where N starts at `position`
 * (the wallet's place among the wallets in use, counting from 1) and goes up
 * while another wallet is already named "Wallet N". Names match ignoring case
 * and surrounding or repeated spaces, so " wallet  2" uses 2; any other name,
 * such as "Qbit HD Wallet #2" or "Wallet #2", uses no number.
 */
export function defaultWalletName(position: number, otherNames: Iterable<unknown>): string {
  const used = new Set<string>()
  for (const name of otherNames) {
    if (typeof name === 'string') {
      used.add(comparableWalletName(name))
    }
  }
  let number = Number.isSafeInteger(position) && position > 0 ? position : 1
  while (used.has(comparableWalletName(`Wallet ${number}`))) {
    number += 1
  }
  return `Wallet ${number}`
}
