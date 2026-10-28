import { useCallback } from 'react';

import { Column, Content, Header, Icon, Layout, OptionListCard, Row, Text } from '@/ui/components';
import { THEME_MODES, ThemeMode } from '@qbit/wallet-shared';
import { useI18n, useSetThemeModeCallback, useThemeMode } from '@qbit/wallet-state';

const MODE_LABEL_KEY: Record<ThemeMode, string> = {
  light: 'theme_light',
  dark: 'theme_dark',
  system: 'theme_system'
};

const MODE_ICON: Record<ThemeMode, 'theme-light' | 'theme-dark' | 'theme-system'> = {
  light: 'theme-light',
  dark: 'theme-dark',
  system: 'theme-system'
};

export default function AppearanceScreen() {
  const { t } = useI18n();
  const themeMode = useThemeMode();
  const setThemeMode = useSetThemeModeCallback();

  const handleSelect = useCallback(
    async (mode: ThemeMode) => {
      if (mode === themeMode) return;
      try {
        await setThemeMode(mode);
      } catch (error) {
        console.error('change theme mode error:', error);
      }
    },
    [setThemeMode, themeMode]
  );

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('appearance')}
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
            {THEME_MODES.map((mode) => {
              const selected = mode === themeMode;
              return (
                <Row
                  key={mode}
                  onClick={() => handleSelect(mode)}
                  itemsCenter
                  justifyBetween
                  style={{
                    padding: '10px 16px',
                    cursor: 'pointer',
                    minHeight: '34px'
                  }}
                  full
                  data-testid={`appearance-option-${mode}`}
                >
                  <Row itemsCenter>
                    <Icon icon={MODE_ICON[mode]} color={selected ? 'accentDark' : 'textDim'} size={18} />
                    <Text
                      color={selected ? 'accentDark' : 'textDim'}
                      size="sm"
                      text={t(MODE_LABEL_KEY[mode])}
                    />
                  </Row>
                  {selected && <Icon icon="checked" color="gold" size={20} />}
                </Row>
              );
            })}
          </OptionListCard>
        </Column>
      </Content>
    </Layout>
  );
}
