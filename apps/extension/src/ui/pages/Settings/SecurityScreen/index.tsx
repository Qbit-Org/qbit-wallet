import { useEffect, useState } from 'react';
import { useNavigate as useRouterNavigate } from 'react-router-dom';

import { Column, Content, Header, Layout } from '@/ui/components';
import { ResetWalletPopover } from '@/ui/components/ResetWalletPopover';
import { spacing } from '@/ui/theme/spacing';
import { hasRecoveryPhrase } from '@/ui/utils/recoveryPhrase';
import { SettingsItemType, useBooted, useCurrentKeyring, useI18n, useIsReady, useNavigation } from '@qbit/wallet-state';

import { SettingsItemRow } from '../../Main/SettingsTabScreen/SettingsItemRow';
import { PhishingProtectionCard } from './PhishingProtectionCard';
import { SecurityCard, TouchIdUnlockRow } from './SecurityCard';

/**
 * Settings → Security, one list that scrolls as one: Change Password, Touch ID
 * Unlock where the browser can do it, Show Secret Recovery Phrase for the
 * current wallet when it has one, the lock settings (Automatic Lock Time and
 * the two lock switches), the state of phishing protection, and Reset Wallet
 * last.
 *
 * A screen of a wallet: a page that has started and found nothing booted
 * shows nothing of it, and goes to Welcome in this entry's place, so that
 * Back does not come here again. It never offers the reset there: such a
 * page names no wallet in its requests, and the background refuses a reset
 * that names none whenever a wallet is booted, as one may have been since in
 * another window. While the page is still starting it does not know yet,
 * and shows nothing either.
 */
export default function SecurityScreen() {
  const { t } = useI18n();
  const nav = useNavigation();
  const routerNavigate = useRouterNavigate();
  const currentKeyring = useCurrentKeyring();
  const isReady = useIsReady();
  const isBooted = useBooted();
  const [resetOpen, setResetOpen] = useState(false);
  // A reset this window sent keeps the screen and its dialog: the page's
  // store forgets the wallet as the background announces the reset, before
  // its answer, and the page reopens on Welcome once that answer has come
  // (installPageWalletResetHandler).
  const withoutWallet = isReady && !isBooted && !resetOpen;

  useEffect(() => {
    if (withoutWallet) routerNavigate('/welcome', { replace: true });
  }, [withoutWallet, routerNavigate]);

  const goBack = () => {
    // Opened as the first history entry (e.g. directly by URL) there is
    // nothing behind it (react-router marks the first entry with idx 0):
    // put Settings in its place.
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (historyIndex > 0) {
      window.history.go(-1);
    } else {
      routerNavigate('/settings', { replace: true });
    }
  };

  const changePasswordItem: SettingsItemType = {
    key: 'security_changePassword',
    label: t('change_password'),
    right: true,
    icon: 'changePassword',
    onClick: () => nav.navigate('ChangePasswordScreen')
  };
  const showPhraseItem: SettingsItemType | null = hasRecoveryPhrase(currentKeyring)
    ? {
        key: 'security_showSeedPhrase',
        label: t('show_secret_recovery_phrase'),
        right: true,
        icon: 'recoveryPhrase',
        onClick: () => nav.navigate('ExportMnemonicsScreen', { keyring: currentKeyring })
      }
    : null;
  const resetItem: SettingsItemType = {
    key: 'security_resetWallet',
    label: t('reset_wallet'),
    danger: true,
    right: true,
    icon: 'reset',
    onClick: () => setResetOpen(true)
  };

  if (!isReady || withoutWallet) return null;

  return (
    <Layout>
      <Header onBack={goBack} title={t('security')} />
      <Content>
        <Column fullX style={{ gap: spacing.extraSmall }}>
          <SettingsItemRow item={changePasswordItem} />
          <TouchIdUnlockRow />
          {showPhraseItem && <SettingsItemRow item={showPhraseItem} />}
          <SecurityCard />
          <PhishingProtectionCard />
          {/* Last, below everything else: the one entry that erases. */}
          <SettingsItemRow item={resetItem} />
        </Column>
      </Content>
      {resetOpen && <ResetWalletPopover onClose={() => setResetOpen(false)} />}
    </Layout>
  );
}
