import { useState } from 'react';

import { Button, Column, Content, Header, Input, Layout, Text } from '@/ui/components';
import { walletErrorMessage } from '@/ui/utils';
import { useBackToSettingsParent } from '@/ui/utils/settingsBack';
import {
  BiometricCeremonyCancelledError,
  BiometricEnrollmentIncompleteError,
  BiometricPasswordInvalidError,
  BiometricPrfUnsupportedError,
  useBiometricUnlock,
  useI18n,
  useTools
} from '@qbit/wallet-state';

/**
 * Settings → Security → Touch ID Unlock. Enrollment requires the wallet
 * password (step-up) and runs the WebAuthn ceremony in this page. In the
 * popup surface the browser's TouchID prompt can close the popup mid-flow;
 * a dismissed or interrupted ceremony saves no record, so the user simply
 * retries.
 */
export default function BiometricUnlockScreen() {
  const { t } = useI18n();
  const tools = useTools();
  // The Security screen lists this entry, so Back with nothing behind this
  // screen lands there.
  const goBack = useBackToSettingsParent('/settings/security');
  const { ready, supported, enrolled, enroll, disable } = useBiometricUnlock();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const onEnable = async () => {
    if (loading || !password) {
      return;
    }
    setLoading(true);
    try {
      await enroll(password);
      setPassword('');
      tools.toastSuccess(t('success'));
    } catch (e) {
      if (
        e instanceof BiometricCeremonyCancelledError ||
        (e instanceof BiometricEnrollmentIncompleteError && e.cancelled)
      ) {
        // The user dismissed a TouchID prompt; no record was saved (a
        // dismissed second prompt also discards any prior record, since its
        // credential was just overwritten).
      } else if (e instanceof BiometricPasswordInvalidError) {
        tools.toastError(t('password_error'));
      } else if (e instanceof BiometricPrfUnsupportedError) {
        tools.toastError(t('touch_id_prf_unsupported'));
      } else {
        tools.toastError((e as Error).message || t('touch_id_setup_failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const onDisable = async () => {
    if (loading) {
      return;
    }
    setLoading(true);
    try {
      await disable();
      tools.toastSuccess(t('success'));
    } catch (e) {
      tools.toastError(walletErrorMessage(e, t('unknown_error')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <Header onBack={goBack} title={t('touch_id_unlock')} />
      <Content>
        <Column gap="lg">
          <Text preset="sub" text={t('enable_touch_id_desc')} />
          {!ready ? null : !supported ? (
            <Text text={t('touch_id_prf_unsupported')} color="warning" />
          ) : enrolled ? (
            <Column gap="lg">
              <Text text={t('touch_id_status_on')} color="gold" data-testid="touch-id-status" />
              <Button
                disabled={loading}
                text={t('disable_touch_id')}
                preset="default"
                onClick={onDisable}
                data-testid="disable-touch-id-button"
              />
            </Column>
          ) : (
            <Column gap="lg">
              <Text preset="sub" text={t('enter_password_to_enable_touch_id')} />
              <Input
                preset="password"
                placeholder={t('password')}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={true}
                data-testid="touch-id-password-input"
              />
              <Button
                disabled={loading || !password}
                text={t('enable_touch_id')}
                preset="primary"
                onClick={onEnable}
                data-testid="enable-touch-id-button"
              />
            </Column>
          )}
        </Column>
      </Content>
    </Layout>
  );
}
