import { useState } from 'react';
import { useNavigate as useRouterNavigate } from 'react-router-dom';

import { Column, Content, Header, Layout } from '@/ui/components';
import { ResetWalletPopover } from '@/ui/components/ResetWalletPopover';
import { spacing } from '@/ui/theme/spacing';
import { hasRecoveryPhrase } from '@/ui/utils/recoveryPhrase';
import { SettingsItemType, useCurrentKeyring, useI18n, useNavigation } from '@qbit/wallet-state';

import { SettingsItemRow } from '../Main/SettingsTabScreen/SettingsItemRow';

/**
 * Settings → Security: Change Password, Show Secret Recovery Phrase for the
 * current wallet when it has one, and Reset Wallet. Touch ID, the auto-lock
 * time and the lock switches stay in Advanced Settings.
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

  const items: SettingsItemType[] = [
    {
      key: 'security_changePassword',
      label: t('change_password'),
      right: true,
      icon: 'changePassword',
      onClick: () => nav.navigate('ChangePasswordScreen')
    }
  ];
  if (hasRecoveryPhrase(currentKeyring)) {
    items.push({
      key: 'security_showSeedPhrase',
      label: t('show_secret_recovery_phrase'),
      right: true,
      icon: 'recoveryPhrase',
      onClick: () => nav.navigate('ExportMnemonicsScreen', { keyring: currentKeyring })
    });
  }
  items.push({
    key: 'security_resetWallet',
    label: t('reset_wallet'),
    danger: true,
    right: true,
    icon: 'reset',
    onClick: () => setResetOpen(true)
  });

  return (
    <Layout>
      <Header onBack={goBack} title={t('security')} />
      <Content>
        <Column fullX style={{ gap: spacing.extraSmall }}>
          {items.map((item) => (
            <SettingsItemRow key={item.key} item={item} />
          ))}
        </Column>
      </Content>
      {resetOpen && <ResetWalletPopover onClose={() => setResetOpen(false)} />}
    </Layout>
  );
}
