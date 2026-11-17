import { useEffect, useState } from 'react';

import { Content, Header, Layout } from '@/ui/components';
import LoadingPage from '@/ui/components/LoadingPage';
import { useI18n } from '@qbit/wallet-state';

import { AddressTypeSettingCard } from './AddressTypeSetting';
import { LanguageCard } from './Language';
import { RegtestAccessCard } from './RegtestAccessCard';

/**
 * Settings → Advanced Settings: Language, Address Type and, in builds that
 * gate it, Local Regtest. The lock settings and the state of phishing
 * protection are on the Security screen.
 */
export default function AdvancedScreen() {
  const { t } = useI18n();

  const [init, setInit] = useState(false);
  useEffect(() => {
    setTimeout(() => {
      setInit(true);
    }, 300);
  }, []);

  if (!init) {
    return <LoadingPage />;
  }

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('advanced_settings')}
      />
      <Content>
        <LanguageCard />

        <AddressTypeSettingCard />

        <RegtestAccessCard />
      </Content>
    </Layout>
  );
}
