import { useCallback, useState } from 'react';

import { Column, Content, Header, Icon, Layout, OptionListCard, Row, Text } from '@/ui/components';
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

export default function LanguageScreen() {
  const { t, locale: currentLocale, changeLocale } = useI18n();
  const [selectedLocale, setSelectedLocale] = useState(currentLocale);

  const handleLanguageSelect = useCallback(
    async (locale: string) => {
      if (locale === currentLocale) return;
      setSelectedLocale(locale);
      try {
        localStorage.setItem('userSelectedLanguage', 'true');
        await changeLocale(locale);

        if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CHANGE_LANGUAGE', locale });
        }

        window.history.go(-1);
      } catch (error) {
        console.error('change locale error:', error);
      }
    },
    [changeLocale, currentLocale]
  );

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('language')}
      />
      <Content>
        <Column
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            marginTop: 16,
            paddingBottom: 16
          }}
        >
          <OptionListCard>
            {SUPPORTED_LOCALES.map((locale) => (
              <Row
                key={locale}
                onClick={() => handleLanguageSelect(locale)}
                itemsCenter
                justifyBetween
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  minHeight: '34px'
                }}
                full
              >
                <Text
                  color={locale === selectedLocale ? 'accentDark' : 'textDim'}
                  size="sm"
                  text={LOCALE_NAMES[locale]}
                />
                {locale === selectedLocale && <Icon icon="checked" color="gold" size={20} />}
              </Row>
            ))}
          </OptionListCard>
        </Column>
      </Content>
    </Layout>
  );
}
