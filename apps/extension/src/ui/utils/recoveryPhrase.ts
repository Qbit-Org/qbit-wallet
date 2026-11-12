import { KeyringType } from '@qbit/wallet-shared';

/** Wallets made from a recovery phrase, which the vault keeps with them. */
const MNEMONIC_BACKED_KEYRING_TYPES: string[] = [KeyringType.HdKeyring, KeyringType.QbitHdKeyring];

/**
 * Whether Show Secret Recovery Phrase is offered for `keyring`: the account
 * switcher's wallet menu and Settings → Security both ask this.
 */
export function hasRecoveryPhrase(keyring: { type: string }): boolean {
  return MNEMONIC_BACKED_KEYRING_TYPES.includes(keyring.type);
}
