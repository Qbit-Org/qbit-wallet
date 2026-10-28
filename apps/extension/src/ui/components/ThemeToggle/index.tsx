import { useEffect, useState } from 'react';

import { Icon, Row, Tooltip } from '@/ui/components';
import { useI18n, useSetThemeModeCallback, useThemeMode } from '@qbit/wallet-state';

export function ThemeToggle() {
  const { t } = useI18n();
  const themeMode = useThemeMode();
  const setThemeMode = useSetThemeModeCallback();
  const [isHovered, setIsHovered] = useState(false);
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // The header toggle only flips between light and dark; system stays
  // selectable in Settings -> Appearance. While in system mode it shows the
  // resolved theme, and a click switches to the opposite explicit mode.
  const resolvedTheme = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode;
  const isDark = resolvedTheme === 'dark';

  return (
    <Row
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
    >
      <Tooltip
        title={`${t('appearance')}: ${t(isDark ? 'theme_dark' : 'theme_light')}`}
        overlayStyle={{
          minWidth: '70px',
          fontSize: '12px'
        }}
        placement="bottom"
      >
        <div
          onClick={() => {
            setThemeMode(isDark ? 'light' : 'dark');
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{ display: 'inline-block', cursor: 'pointer' }}
          data-testid="theme-toggle"
        >
          <Icon
            icon={isDark ? 'theme-dark' : 'theme-light'}
            size={20}
            color={isHovered ? 'accent' : 'muted'}
            containerStyle={{
              opacity: isHovered ? 1 : 0.8
            }}
          />
        </div>
      </Tooltip>
    </Row>
  );
}
