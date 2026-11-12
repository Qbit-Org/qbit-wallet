import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  // Outside an approval window, the route this screen has taken after an
  // unlock: Home or Welcome in this screen's history entry, or the step back
  // to a send form a lock interrupted, in the entry before it.
  const tookRef = useRef<'MainScreen' | 'WelcomeScreen' | '#back' | undefined>(undefined);
  // Set once this screen has gone, with the address the page showed then.
  const goneRef = useRef(false);
  const addressWhenGoneRef = useRef('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    goneRef.current = false;
    return () => {
      goneRef.current = true;
      addressWhenGoneRef.current = window.location.href;
    };
  }, []);

  // Outside an approval window, Home and Welcome take this screen's history
  // entry, so Back never returns to the unlock screen of an unlocked wallet.
  // Home goes there once, never over Welcome, and not once this screen has
  // gone. Welcome, for a wallet without a vault, goes there once, also over
  // what a route of this screen already put there. Once this screen has gone
  // some other way, or the page has moved on since a route of its own, either
  // would replace another screen's entry: then neither goes anywhere.
  const leaveFor = useCallback(
    (routeKey: 'MainScreen' | 'WelcomeScreen') => {
      const took = tookRef.current;
      const gone = goneRef.current;
      if (routeKey === 'MainScreen') {
        // A step back that left this screen up went nowhere: Home is still due.
        if (gone || (took !== undefined && took !== '#back')) {
          return;
        }
      } else if (
        took === 'WelcomeScreen' ||
        (gone && (took === undefined || window.location.href !== addressWhenGoneRef.current))
      ) {
        return;
      }
      tookRef.current = routeKey;
      // After the step back to the send form the page is on the form's entry,
      // and this screen's entry is the next one: a new entry takes its place.
      navigate(routeKey, undefined, undefined, { replace: !(gone && took === '#back') });
    },
    [navigate]
  );

  // Back to the send form a lock interrupted in this page, for both routes
  // an unlock takes here; never in an approval window. Its way Home goes
  // through leaveFor; its step back to the form stays a step back.
  const sendFormNavigate = useCallback(
    (to: 'MainScreen' | '#back') => {
      if (to === 'MainScreen') {
        leaveFor('MainScreen');
        return;
      }
      tookRef.current = '#back';
      navigate('#back');
    },
    [leaveFor, navigate]
  );
  const sendFormReturn = useSendFormReturn(sendFormNavigate);

  useEffect(() => {
    if (!isUnlocked) {
      locksRef.current += 1;
    }
  }, [isUnlocked]);

  // Both routes below see this screen's own unlock, so they share one read of
  // whether there is a vault per unlock, and only that read acts on the
  // answer. `locks` dates it: after a lock, the answer is for an unlock that
  // has ended.
  const vaultReadRef = useRef<{ locks: number; hasVault: Promise<boolean> } | undefined>(undefined);
  const readVault = useCallback((): Promise<boolean> => {
    const locks = locksRef.current;
    if (vaultReadRef.current?.locks === locks) {
      return vaultReadRef.current.hasVault;
    }
    // The port throws when it refuses a request: a failed read, as a rejection is.
    const hasVault = new Promise<boolean>((resolve) => resolve(wallet.hasVault()));
    vaultReadRef.current = { locks, hasVault };
    hasVault.then(
      (found) => {
        if (found || locksRef.current !== locks) {
          return;
        }
        // As it went, this screen gave up its send form; one remembered since
        // then is a later unlock's.
        if (!goneRef.current) {
          sendFormReturn.abandon();
        }
        leaveFor('WelcomeScreen');
      },
      // A failed read leaves the page where it went.
      () => undefined
    );
    return hasVault;
  }, [wallet, leaveFor, sendFormReturn]);

  // Every unlock comes this way first, this screen's own too: the store turns
  // unlocked before that unlock returns. Which one it is cannot be told here
  // (an attempt in flight, such as a Touch ID prompt left open, may not be
  // what unlocked), so a hidden page waits until it is shown, as for another
  // window's unlock; navigateAfterUnlock ends that wait for this screen's own.
  // With no send form to return to, Home takes this screen's place at once,
  // as it does when Back or Forward comes back here once unlocked. Home does
  // not wait for the vault read: without a vault, Welcome takes its place.
  useEffect(() => {
    if (!isUnlocked || isInNotification) {
      return;
    }
    if (!sendFormReturn.route(false)) {
      leaveFor('MainScreen');
    }
    readVault();
  }, [isUnlocked, isInNotification, leaveFor, sendFormReturn, readVault]);

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
    // Usually the read the store's route began for this same unlock.
    const hasVault = await readVault();
    // After a lock since the attempt began, the unlock is not taken for this
    // screen's own, whoever made it: the page waits as for another window's.
    const ownUnlock = locksRef.current === locksAtStart;
    // Without a vault, the read has sent the page to Welcome, if still due.
    if (!hasVault) {
      return;
    }
    // Once this screen has gone, it has no wait to end and no route to take.
    if (!goneRef.current && !sendFormReturn.route(ownUnlock)) {
      leaveFor('MainScreen');
    }
  };

  const btnClick = async () => {
    if (unlockInFlightRef.current) {
      return;
    }
    unlockInFlightRef.current = true;
    const locksAtStart = locksRef.current;
    setLoading(true);
    let unlocked = false;
    try {
      await unlock(password);
      unlocked = true;
      unlockedHereRef.current = true;
      await navigateAfterUnlock(locksAtStart);
    } catch (e) {
      console.log(e);
      // After an unlock that worked, only the routing failed: no unlock error
      // to show. The store turned unlocked before the unlock returned, and
      // the effect above routes the page as it does for any unlock.
      if (unlocked) {
        return;
      }
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
    let unlocked = false;
    try {
      await unlockWithBiometric();
      unlocked = true;
      unlockedHereRef.current = true;
      await navigateAfterUnlock(locksAtStart);
    } catch (e) {
      if (unlocked) {
        // As for the password: only the routing failed.
        console.log(e);
      } else if (e instanceof BiometricCeremonyCancelledError) {
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
