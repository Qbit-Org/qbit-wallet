import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Column, Content, Layout, Row } from '@/ui/components';
import { Button } from '@/ui/components/Button';
import { Input } from '@/ui/components/Input';
import { Logo } from '@/ui/components/Logo';
import { Text } from '@/ui/components/Text';
import { useSendFormReturn } from '@/ui/utils/sendFormReturn';
import { getUiType } from '@/ui/web';
import { ErrorCodes } from '@qbit/wallet-shared';
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
  // The locks the store has reported while this screen is up. An attempt's
  // unlock is still the current one only if none has come since it began.
  const locksRef = useRef(0);
  const [loading, setLoading] = useState(false);
  // Back to the send form a lock interrupted in this page, for both routes
  // an unlock takes here; never in an approval window.
  const sendFormReturn = useSendFormReturn(navigate);

  useEffect(() => {
    if (!isUnlocked) {
      locksRef.current += 1;
    }
  }, [isUnlocked]);

  // Every unlock comes this way first, this screen's own too: the store turns
  // unlocked before that unlock returns. Which one it is cannot be told here
  // (an attempt in flight, such as a Touch ID prompt left open, may not be
  // what unlocked), so a hidden page waits until it is shown, as for another
  // window's unlock; navigateAfterUnlock ends that wait for this screen's own.
  useEffect(() => {
    if (isUnlocked && !isInNotification && !sendFormReturn.route(false)) {
      navigate('MainScreen');
    }
  }, [isUnlocked, isInNotification, navigate, sendFormReturn]);

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

  // `locksAtStart`: the locks seen when the attempt that unlocked began.
  const navigateAfterUnlock = async (locksAtStart: number) => {
    if (isInNotification) {
      // useUnlockCallback settled only an unlock request; BoostScreen shows
      // any other pending approval again or closes the window.
      navigation.navToRootHome();
      return;
    }
    const hasVault = await wallet.hasVault();
    // After a lock since the attempt began, the unlock is not taken for this
    // screen's own, whoever made it: the page waits as for another window's.
    const ownUnlock = locksRef.current === locksAtStart;
    if (!hasVault) {
      sendFormReturn.abandon();
      navigate('WelcomeScreen');
    } else if (!sendFormReturn.route(ownUnlock)) {
      navigate('MainScreen');
    }
  };

  const btnClick = async () => {
    if (unlockInFlightRef.current) {
      return;
    }
    unlockInFlightRef.current = true;
    const locksAtStart = locksRef.current;
    setLoading(true);
    try {
      await unlock(password);
      unlockedHereRef.current = true;
      await navigateAfterUnlock(locksAtStart);
    } catch (e) {
      console.log(e);
      // The wallet locked while unlocking (the computer locked, say); the
      // password was not the problem.
      tools.toastError(
        (e as { code?: unknown } | null)?.code === ErrorCodes.WALLET_LOCKED_DURING_UNLOCK
          ? t('wallet_locked_during_unlock')
          : t('password_error')
      );
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
    const locksAtStart = locksRef.current;
    setLoading(true);
    try {
      await unlockWithBiometric();
      unlockedHereRef.current = true;
      await navigateAfterUnlock(locksAtStart);
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
