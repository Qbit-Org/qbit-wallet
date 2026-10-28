import { useEffect, useMemo, useState } from 'react';
import { useNavigate as useRouterNavigate } from 'react-router-dom';

import { Button, Column, Content, Header, Input, Layout, Row, Text } from '@/ui/components';
import { getPasswordStrengthWord, MIN_PASSWORD_LENGTH } from '@/ui/utils/password-utils';
import { useBiometricUnlock, useI18n, useTools } from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

export default function ChangePasswordScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [originPassword, setOriginPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [disabled, setDisabled] = useState(true);
  const tools = useTools();
  const { changePasswordKeepingBiometric } = useBiometricUnlock();
  const routerNavigate = useRouterNavigate();

  const [loading, setLoading] = useState(false);

  const goBack = () => {
    // When this screen loads as the first history entry (e.g. opened
    // directly by URL) there is nothing behind it; rebuild the natural
    // chain like BiometricUnlockScreen does.
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (historyIndex > 0) {
      window.history.go(-1);
    } else {
      routerNavigate('/settings', { replace: true });
      routerNavigate('/settings/advanced');
    }
  };

  const strongText = useMemo(() => {
    if (!newPassword) {
      return;
    }
    const { text, color, tip } = getPasswordStrengthWord(newPassword, t);

    return (
      <Column>
        <Row>
          <Text size="xs" text={`${t('password_strength')}: `} />
          <Text size="xs" text={text} style={{ color: color }} />
        </Row>
        {tip ? <Text size="xs" preset="sub" text={tip} /> : null}
      </Column>
    );
  }, [newPassword]);

  const matchText = useMemo(() => {
    if (!confirmPassword) {
      return;
    }

    if (newPassword !== confirmPassword) {
      return (
        <Row>
          <Text size="xs" text={t('passwords_dont_match')} color="dangerText" />
        </Row>
      );
    } else {
      return;
    }
  }, [newPassword, confirmPassword]);

  useEffect(() => {
    if (
      originPassword.length > 0 &&
      newPassword.length >= MIN_PASSWORD_LENGTH &&
      newPassword === confirmPassword &&
      loading === false
    ) {
      setDisabled(false);
    } else {
      setDisabled(true);
    }
  }, [originPassword, newPassword, confirmPassword]);

  const verify = async () => {
    try {
      if (loading) {
        return;
      }
      setLoading(true);
      // The hook owns the change protocol (snapshot record → change → one
      // TouchID re-wrap); the screen only maps the outcome to a toast.
      const outcome = await changePasswordKeepingBiometric(originPassword, newPassword);
      if (outcome === 'kept') {
        tools.toastSuccess(t('touch_id_reenabled_after_password_change'));
      } else if (outcome === 'dropped') {
        tools.toastError(t('touch_id_disabled_after_password_change'));
      } else {
        tools.toastSuccess(t('success'));
      }
      navigate('MainScreen');
    } catch (err) {
      tools.toastError((err as any).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Layout>
      <Header onBack={goBack} title={t('change_password')} />
      <Content>
        <Column gap="lg">
          <Input
            preset="password"
            placeholder={t('current_password')}
            onChange={(e) => {
              setOriginPassword(e.target.value);
            }}
            autoFocus={true}
            data-testid="current-password-input"
          />
          <Input
            preset="password"
            placeholder={t('new_password')}
            onChange={(e) => {
              setNewPassword(e.target.value);
            }}
            data-testid="new-password-input"
          />
          {strongText}
          <Input
            preset="password"
            placeholder={t('confirm_password')}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
            }}
            data-testid="confirm-password-input"
          />
          {matchText}
          <Button
            disabled={disabled}
            text={t('change_password')}
            preset="primary"
            onClick={() => {
              verify();
            }}
            data-testid="change-password-confirm-button"
          />
        </Column>
      </Content>
    </Layout>
  );
}
