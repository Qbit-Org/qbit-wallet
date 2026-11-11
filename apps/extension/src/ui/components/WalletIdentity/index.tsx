import { Wallet } from 'lucide-react';
import { CSSProperties } from 'react';

import { WALLET_COLOR_VALUES } from '@/ui/theme/walletColors';
import { KeyringType, QbitRecoveryState, WalletKeyring, resolveWalletColor } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import './index.less';

/**
 * A square in the wallet's color with the wallet glyph. It only repeats the
 * wallet name next to it, so it is hidden from assistive technology.
 */
export function WalletAvatar({
  keyring,
  size = 24,
  'data-testid': dataTestId
}: {
  keyring: Pick<WalletKeyring, 'color' | 'index'>;
  size?: number;
  'data-testid'?: string;
}) {
  const color = resolveWalletColor(keyring.color, keyring.index);
  const value = WALLET_COLOR_VALUES[color];
  const style = {
    width: size,
    height: size,
    '--wallet-avatar-light': value.light,
    '--wallet-avatar-dark': value.dark
  } as CSSProperties;
  return (
    <span className="wallet-avatar" style={style} data-color={color} data-testid={dataTestId} aria-hidden="true">
      <Wallet size={Math.round(size * 0.58)} strokeWidth={2.25} aria-hidden="true" focusable="false" />
    </span>
  );
}

export type WalletTag = 'read-only' | 'recovered' | 'archived' | 'cold';

const READ_ONLY_KEYRING_TYPES: string[] = [KeyringType.ReadonlyKeyring, KeyringType.WatchAddressKeyring];

/** Whether a wallet holds no keys that can sign: a read-only or watched address. */
export function isReadOnlyWallet(keyring: Pick<WalletKeyring, 'type'>): boolean {
  return READ_ONLY_KEYRING_TYPES.includes(keyring.type);
}

/**
 * The tags a wallet shows next to its name. `recovery` is the freshest
 * recovery state known for the wallet; the keyring's own snapshot is used
 * when none is given.
 */
export function walletTagsFor(
  keyring: Pick<WalletKeyring, 'type' | 'qbitRecovery'>,
  recovery: QbitRecoveryState | undefined = keyring.qbitRecovery
): WalletTag[] {
  const tags: WalletTag[] = [];
  if (isReadOnlyWallet(keyring)) {
    tags.push('read-only');
  }
  if (keyring.type === KeyringType.QbitHdKeyring) {
    const status = recovery?.status;
    if (status === 'seed-only-restored' || status === 'migrating') {
      tags.push('recovered');
    } else if (status === 'migrated') {
      tags.push('archived');
    }
  }
  if (keyring.type === KeyringType.ColdWalletKeyring) {
    tags.push('cold');
  }
  return tags;
}

const TAG_LABEL_KEYS: Record<WalletTag, string> = {
  'read-only': 'wallet_tag_read_only',
  recovered: 'wallet_tag_recovered',
  archived: 'wallet_tag_archived',
  cold: 'linked_to_cold_wallet'
};

/** The wallet's tags, as small labels that never shrink. */
export function WalletTags({ tags, testIdFor }: { tags: WalletTag[]; testIdFor: (tag: WalletTag) => string }) {
  const { t } = useI18n();
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <span key={tag} className={`wallet-tag wallet-tag--${tag}`} data-testid={testIdFor(tag)}>
          {t(TAG_LABEL_KEYS[tag])}
        </span>
      ))}
    </>
  );
}
