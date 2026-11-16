import { useState } from 'react';
import { useNavigate as useRouterNavigate } from 'react-router-dom';

import { Column, Content, Header, Layout } from '@/ui/components';
import { ResetWalletPopover } from '@/ui/components/ResetWalletPopover';
import { spacing } from '@/ui/theme/spacing';
import { hasRecoveryPhrase } from '@/ui/utils/recoveryPhrase';
import { SettingsItemType, useCurrentKeyring, useI18n, useNavigation } from '@qbit/wallet-state';

import { SettingsItemRow } from '../../Main/SettingsTabScreen/SettingsItemRow';
import { PhishingProtectionCard } from './PhishingProtectionCard';
import { SecurityCard, TouchIdUnlockRow } from './SecurityCard';

/**
 * Settings → Security, one list that scrolls as one: Change Password, Touch ID
 * Unlock where the browser can do it, Show Secret Recovery Phrase for the
 * current wallet when it has one, the lock settings (Automatic Lock Time and
 * the two lock switches), the state of phishing protection, and Reset Wallet
 * last.
 */
export default function SecurityScreen() {
  const { t } = useI18n();
  const nav = useNavigation();
  const routerNavigate = useRouterNavigate();
  const currentKeyring = useCurrentKeyring();
  const [resetOpen, setResetOpen] = useState(false);

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
