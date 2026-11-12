import { ChevronsUpDown, Copy } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { AccountSwitcherSheet } from '@/ui/components/AccountSwitcher';
import { WalletAvatar, WalletTags, walletTagsFor } from '@/ui/components/WalletIdentity';
import { shortAddress } from '@/ui/utils';
import { QbitRecoveryState } from '@qbit/wallet-shared';
import { useCurrentAccount, useCurrentKeyring, useI18n, useTools } from '@qbit/wallet-state';

import './index.less';

interface AccountSelectProps {
  /**
   * The current wallet's recovery state as the home screen last fetched it.
   * The keyring snapshot in the store goes stale after a recovery change, so
   * the tags follow this, as the recovery cards do.
   */
  recoveryState?: QbitRecoveryState;
}

/**
 * The home screen's account card: which wallet and account are open. Tapping
 * the address copies it; tapping anywhere else opens the account switcher.
 */
const AccountSelect = ({ recoveryState }: AccountSelectProps) => {
  const currentKeyring = useCurrentKeyring();
  const currentAccount = useCurrentAccount();
  const tools = useTools();
  const { t } = useI18n();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const address = currentAccount.address;
  const walletName = currentKeyring.alianName;
  const accountName = currentAccount.alianName ?? '';
  const tags = walletTagsFor(currentKeyring, recoveryState ?? currentKeyring.qbitRecovery);

  const closeSwitcher = useCallback(() => {
    setSwitcherOpen(false);
    // The card stays mounted after a switch, so focus can go back to it.
    openButtonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="account-card">
        {/* Covers the whole card under the copy control, so a tap anywhere else opens the switcher.
            Being on top of the account name, it also carries it in full for the pointer, with the
            name of the wallet, which the card shows only by its tile. */}
        <button
          ref={openButtonRef}
          type="button"
          className="account-card__open"
          aria-haspopup="dialog"
          aria-expanded={switcherOpen}
          aria-label={t('account_switcher_open_label', [accountName, walletName])}
          title={`${walletName}\n${accountName}`}
          onClick={() => setSwitcherOpen(true)}
          data-testid="account-select"
        />
        <WalletAvatar keyring={currentKeyring} size={28} data-testid="account-select-wallet-tile" />
        <div className="account-card__text">
          <div className="account-card__name-line">
            <span className="account-card__account-name" data-testid="account-select-account-name">
              {accountName}
            </span>
            <WalletTags tags={tags} testIdFor={(tag) => `account-select-tag-${tag}`} />
          </div>
          <button
            type="button"
            className="account-card__copy"
            aria-label={t('account_switcher_copy_address_label', [accountName])}
            onClick={() => tools.copyToClipboard(address)}
            data-testid="account-select-copy"
          >
            <span className="account-card__address">{shortAddress(address)}</span>
            <Copy size={13} aria-hidden="true" focusable="false" />
          </button>
        </div>
        <span className="account-card__chevron" aria-hidden="true">
          <ChevronsUpDown size={15} focusable="false" />
        </span>
      </div>
      {switcherOpen && <AccountSwitcherSheet onClose={closeSwitcher} />}
    </>
  );
};

export default AccountSelect;
