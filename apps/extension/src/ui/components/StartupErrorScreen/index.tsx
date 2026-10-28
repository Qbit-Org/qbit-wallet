import { useEffect, useState } from 'react';

import { i18nService } from '@/shared/utils/i18n';
import { colors } from '@/ui/theme/colors';
import type { BackgroundStartupFailure } from '@/ui/utils/backgroundStartup';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES, SupportedLocale } from '@qbit/wallet-shared';

import { Button } from '../Button';
import { Column } from '../Column';
import { Content } from '../Content';
import { Icon } from '../Icon';
import { Text } from '../Text';

// The language the wallet's pages last showed. The background preference that
// normally decides it is part of what could not be read.
function lastShownLocale(): string {
  try {
    const locale = localStorage.getItem('i18nextLng');
    if (locale && SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
      return locale;
    }
  } catch {
    // localStorage can be denied by privacy settings.
  }
  return FALLBACK_LOCALE;
}

function t(key: string): string {
  try {
    return i18nService.translate(key);
  } catch {
    return key;
  }
}

/**
 * Shown instead of the wallet when background start-up has failed. Retry
 * restarts the extension, which runs start-up again from the start; it writes
 * nothing, so stored data is read again exactly as it was left.
 */
export function StartupErrorScreen({ reason }: { reason: BackgroundStartupFailure['reason'] }) {
  const [localeLoaded, setLocaleLoaded] = useState(false);

  useEffect(() => {
    i18nService
      .changeLanguage(lastShownLocale())
      .catch(() => undefined)
      .finally(() => setLocaleLoaded(true));
  }, []);

  if (!localeLoaded) return null;

  return (
    // Not Layout: it reads the wallet's redux state, which is never set up here.
    <div style={{ width: '100vw', height: '100vh', backgroundColor: colors.background, color: colors.text }}>
      <Content>
        <Column justifyCenter itemsCenter full gap="lg" style={{ padding: '20px' }}>
          <div style={{ marginTop: '40px' }}>
            <Icon icon="error-boundary" size={130} />
          </div>

          <Column gap="sm" itemsCenter style={{ marginTop: '10px', marginBottom: '20px' }}>
            <Text preset="title" text={t('startup_error_title')} textCenter />
            <Text
              preset="regular"
              text={t(
                reason === 'stored-settings-unreadable'
                  ? 'startup_error_stored_settings_unreadable'
                  : 'startup_error_unknown'
              )}
              color="textDim"
              textCenter
            />
          </Column>

          <Column gap="md" itemsCenter fullX style={{ maxWidth: '400px' }}>
            <Button
              preset="primary"
              text={t('startup_error_retry')}
              style={{ width: '280px', height: '48px', flexShrink: 0 }}
              onClick={() => chrome.runtime.reload()}
            />
            <Text preset="sub" text={t('startup_error_retry_hint')} color="textDim" textCenter />
          </Column>
        </Column>
      </Content>
    </div>
  );
}
