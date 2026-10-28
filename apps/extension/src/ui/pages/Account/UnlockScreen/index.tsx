import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Column, Content, Layout, Row } from '@/ui/components';
import { Button } from '@/ui/components/Button';
import { Input } from '@/ui/components/Input';
import { Logo } from '@/ui/components/Logo';
import { Text } from '@/ui/components/Text';
import { getUiType } from '@/ui/web';
import {
  BiometricCeremonyCancelledError,
  BiometricRecordStaleError,
  useApproval,
  useBiometricUnlock,
  useI18n,
  useIsUnlocked,
  useNavigation,
  useTools,
  useUnlockCallback,
  useWallet
} from '@qbit/wallet-state';

import { useNavigate } from '../../MainRoute';

export default function UnlockScreen() {
  const { t } = useI18n();
  const wallet = useWallet();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [password, setPassword] = useState('');
  const [disabled, setDisabled] = useState(true);
  const UIType = getUiType();
  const isInNotification = UIType.isNotification;
  const unlock = useUnlockCallback();
  const tools = useTools();
  const isUnlocked = useIsUnlocked();
  const location = useLocation();
  const { getApproval } = useApproval();
  const {
    ready: biometricReady,
    supported: biometricSupported,
    enrolled: biometricEnrolled,
    unlockWithBiometric
  } = useBiometricUnlock();
  const autoPromptedRef = useRef(false);
  // Synchronous mutual exclusion between the manual password unlock and the
  // biometric ceremony: React's async `loading` state is stale within the
  // same tick, so both entry points check-and-set this ref instead of the
  // state. `loading` stays presentational, and its change also re-runs the
  // approval-window effect below once an attempt ends.
  const unlockInFlightRef = useRef(false);
  // Set once this screen's own unlock succeeds; navigateAfterUnlock routes it.
  const unlockedHereRef = useRef(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isUnlocked && !isInNotification) {
      navigate('MainScreen');
    }
  }, [isUnlocked, isInNotification, navigate]);

  // In an approval window, MainScreen would hide the pending approval. After
  // an unlock in another window, return to root so BoostScreen renders the
  // approval or closes the window; an unlock request is left to the window
  // that unlocked. A local attempt in flight defers this until it ends.
  useEffect(() => {
    if (!isUnlocked || !isInNotification || unlockInFlightRef.current || unlockedHereRef.current) {
      return;
    }
    let cancelled = false;
    getApproval()
      .catch(() => undefined)
      .then((approval) => {
        if (!cancelled && !unlockInFlightRef.current && approval?.data?.lock !== true) {
          navigation.navToRootHome();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isUnlocked, isInNotification, loading, navigation, getApproval]);

  const navigateAfterUnlock = async () => {
    if (isInNotification) {
      // useUnlockCallback settled only an unlock request; BoostScreen shows
      // any other pending approval again or closes the window.
      navigation.navToRootHome();
      return;
    }
    const hasVault = await wallet.hasVault();
    if (!hasVault) {
      navigate('WelcomeScreen');
    } else {
      navigate('MainScreen');
    }
  };

  const btnClick = async () => {
    if (unlockInFlightRef.current) {
      return;
    }
    unlockInFlightRef.current = true;
    setLoading(true);
    try {
      await unlock(password);
      unlockedHereRef.current = true;
      await navigateAfterUnlock();
    } catch (e) {
      console.log(e);
      tools.toastError(t('password_error'));
    } finally {
      unlockInFlightRef.current = false;
      setLoading(false);
    }
  };

  const biometricClick = async () => {
    if (unlockInFlightRef.current) {
      return;
    }
    unlockInFlightRef.current = true;
    setLoading(true);
    try {
      await unlockWithBiometric();
      unlockedHereRef.current = true;
      await navigateAfterUnlock();
    } catch (e) {
      if (e instanceof BiometricCeremonyCancelledError) {
        // The user dismissed the TouchID prompt; the password input stays.
      } else if (e instanceof BiometricRecordStaleError) {
        tools.toastError(t('touch_id_unlock_expired'));
      } else {
        console.log(e);
        tools.toastError((e as Error).message || t('touch_id_unlock_expired'));
      }
    } finally {
      unlockInFlightRef.current = false;
      setLoading(false);
    }
  };

  const showBiometricButton = biometricSupported && biometricEnrolled;

  // Auto-prompt TouchID when the unlock screen appears, except right after an
  // explicit manual lock (navToLock passes autoUnlockByFace: false there);
  // absent state (fresh popup open via BoostScreen or direct load) prompts.
  const routeState = (location.state ?? {}) as { autoUnlockByFace?: boolean };
  const shouldAutoPrompt = routeState.autoUnlockByFace !== false;
  useEffect(() => {
    if (!biometricReady || !showBiometricButton || autoPromptedRef.current) {
      return;
    }
    if (!shouldAutoPrompt) {
      return;
    }
    if (unlockInFlightRef.current) {
      // The user already started a manual unlock; don't fight it.
      return;
    }
    autoPromptedRef.current = true;
    biometricClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biometricReady, showBiometricButton]);

  const handleOnKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!disabled && 'Enter' == e.key) {
      btnClick();
    }
  };

  useEffect(() => {
    if (password && loading === false) {
      setDisabled(false);
    } else {
      setDisabled(true);
    }
  }, [password, loading]);
  return (
    <Layout>
      <Content preset="middle">
        <Column fullX>
          <Row justifyCenter>
            <Logo preset="large" />
          </Row>

          <Column gap="xl" mt="xxl">
            <Text preset="title-bold" text={t('enter_your_password')} textCenter />
            <Input
              preset="password"
              placeholder={t('password')}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={(e) => handleOnKeyUp(e as any)}
              autoFocus={true}
              data-testid="unlock-password-input"
            />
            <Button
              disabled={disabled}
              text={t('unlock')}
              preset="primary"
              onClick={btnClick}
              data-testid="unlock-button"
            />
            {showBiometricButton ? (
              <Button
                disabled={loading}
                text={t('unlock_with_touch_id')}
                preset="default"
                onClick={biometricClick}
                data-testid="unlock-touch-id-button"
              />
            ) : null}
          </Column>
        </Column>
      </Content>
    </Layout>
  );
}
