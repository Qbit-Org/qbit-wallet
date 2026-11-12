import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { colors } from '@/ui/theme/colors';
import { reconcileWalletReset, requestWalletReset } from '@/ui/utils/walletReset';
import { ErrorCodes, QbitRecoveryRemovalReason, QbitResetWalletOptions } from '@qbit/wallet-shared';
import { useI18n, useResetWallet, useTools, useWallet } from '@qbit/wallet-state';

import { Button } from '../Button';
import { Column } from '../Column';
import { Input } from '../Input';
import { KeyboardDialog, keyboardButton } from '../KeyboardDialog';
import { Popover } from '../Popover';
import { isRecoveryRiskAgreementTyped, RecoveryRiskConfirmation } from '../RecoveryRiskConfirmation';
import { Row } from '../Row';
import { Text } from '../Text';

/** A rejection as it crosses the UI port, or as the port makes it when the request is lost. */
interface ResetRejection {
  code?: unknown;
  message?: unknown;
  data?: { reasons?: unknown };
}

/**
 * Asks for the password, then erases every wallet and the wallet data with
 * resetWallet. Opened from Settings → Security, and from the account switcher
 * when the wallet to remove is the last usable one (`lastWalletKey`, that
 * wallet's key). Nothing goes to the background before the user presses Reset
 * Wallet; the background checks the password, for a wallet in a recovery
 * migration the acknowledgement, and for a last-wallet reset that the wallet
 * is still the last usable one. Once the wallets are erased, the page's
 * WALLET_RESET handler takes this window, like every other, to the Welcome
 * screen.
 *
 * `outdated` tells the dialog that the reason it was opened for no longer
 * holds, as when the switcher lists another usable wallet: it then closes,
 * unless a reset it sent is still out, which it shows to the end. It never
 * closes without telling why: a refusal that arrives once the reason is gone
 * is shown as an error toast as the dialog closes, and otherwise the toast
 * says the wallet is no longer the last usable one.
 */
export function ResetWalletPopover({
  lastWalletKey,
  outdated = false,
  onClose
}: {
  lastWalletKey?: string;
  outdated?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tools = useTools();
  const wallet = useWallet();
  const resetWallet = useResetWallet();

  const [password, setPassword] = useState('');
  // A refusal that erased nothing, shown under the password field.
  const [error, setError] = useState('');
  // Non-null once the background reported that the reset touches an active
  // recovery migration and asked for an explicit risk confirmation.
  const [recoveryReasons, setRecoveryReasons] = useState<QbitRecoveryRemovalReason[] | null>(null);
  const [agreement, setAgreement] = useState('');

  // Buttons are plain divs and state lands only on the next render, so a
  // double press (or a cancel racing the reset) needs the ref to be refused
  // synchronously; the state drives the pending visuals.
  const resettingRef = useRef(false);
  const [resetting, setResetting] = useState(false);

  const confirmed = recoveryReasons === null || isRecoveryRiskAgreementTyped(agreement);
  const canReset = password.length > 0 && confirmed && !resetting;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The latest `outdated`, for a refusal that settles later.
  const outdatedRef = useRef(outdated);
  outdatedRef.current = outdated;
  const closedRef = useRef(false);
  // Closes the dialog for its outdated reason, once, with `message` as an
  // error toast: the dialog closes on its own here, so it says why.
  const closeOutdated = useCallback(
    (message: string) => {
      if (closedRef.current) return;
      closedRef.current = true;
      tools.toastError(message);
      onCloseRef.current();
    },
    [tools]
  );
  useEffect(() => {
    if (outdated && !resetting) {
      closeOutdated(t('wallet_reset_not_last_wallet'));
    }
  }, [outdated, resetting, closeOutdated, t]);

  const cancel = () => {
    if (!resettingRef.current) {
      onClose();
    }
  };

  const reset = async () => {
    const acknowledgedReasons = recoveryReasons;
    if (resettingRef.current || password.length === 0) {
      return;
    }
    if (acknowledgedReasons && !isRecoveryRiskAgreementTyped(agreement)) {
      return;
    }
    resettingRef.current = true;
    setResetting(true);
    setError('');
    // A last-wallet reset names its wallet on every attempt, the
    // acknowledged retry included, so the background checks it again.
    const options: QbitResetWalletOptions | undefined =
      lastWalletKey || acknowledgedReasons
        ? {
            ...(lastWalletKey ? { lastWalletKey } : {}),
            ...(acknowledgedReasons
              ? { acknowledgedQbitRecoveryRisks: true, acknowledgedQbitRecoveryReasons: acknowledgedReasons }
              : {})
          }
        : undefined;
    try {
      await requestWalletReset(() => resetWallet(password, options));
      // Erased: the window reopens on the Welcome screen, so the dialog stays
      // pending until it goes.
      return;
    } catch (e) {
      const rejection: ResetRejection = typeof e === 'object' && e !== null ? e : {};
      if (rejection.code === ErrorCodes.WALLET_RESET_INCOMPLETE) {
        // The wallets are gone and every window was told: this one reopens on
        // the Welcome screen and shows the message there.
        return;
      }
      if (rejection.code === ErrorCodes.WALLET_RESET_NOT_LAST_WALLET) {
        // The background found, inside the reset, that the wallet is gone or
        // is no longer the last usable one: nothing was erased, and the reason
        // this dialog was opened for is gone.
        closeOutdated(
          typeof rejection.message === 'string' && rejection.message
            ? rejection.message
            : t('wallet_reset_not_last_wallet')
        );
        return;
      }
      if (rejection.code === ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED) {
        if (outdatedRef.current) {
          // The reset can no longer be offered for this wallet, so there are
          // no risks left to acknowledge: say why the dialog goes instead.
          closeOutdated(t('wallet_reset_not_last_wallet'));
          return;
        }
        // A wallet is part of a recovery migration. A confirmed retry lands
        // here again only when the risks changed while the warning was open,
        // so the refreshed reason list must be confirmed from scratch.
        resettingRef.current = false;
        setResetting(false);
        const reasons = rejection.data?.reasons;
        setRecoveryReasons(Array.isArray(reasons) ? reasons : []);
        setAgreement('');
        return;
      }
      // The background refuses before it erases anything, but a request the
      // port lost (code 4900) may have run, and its WALLET_RESET be lost with
      // it. So the dialog asks the background before telling the user anything:
      // - erased: no wallet is left, and the window reopens on the Welcome
      //   screen, as on WALLET_RESET;
      // - kept: the wallets are there, so the message says why the reset did
      //   not run, next to the password the user can correct and send again;
      // - unknown: that question failed too, so the message is all the dialog
      //   knows: it shows it, and claims nothing more.
      const outcome = await reconcileWalletReset(() => wallet.isBooted());
      if (outcome === 'erased') {
        return;
      }
      const message =
        typeof rejection.message === 'string' && rejection.message ? rejection.message : t('unknown_error');
      if (outdatedRef.current) {
        // The reason the dialog was opened for went while the request was
        // out: the dialog goes, and says what the background answered.
        closeOutdated(message);
        return;
      }
      resettingRef.current = false;
      setResetting(false);
      setRecoveryReasons(null);
      setAgreement('');
      setError(message);
    }
  };

  const header = (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: '1.5rem',
        alignItems: 'center',
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: colors.danger,
        justifyContent: 'center'
      }}
    >
      <RotateCcw style={{ height: '1rem', width: '1rem', color: colors.onDanger }} />
    </div>
  );

  const buttons = (
    <Row full>
      <Button
        text={t('cancel')}
        full
        disabled={resetting}
        data-testid="reset-wallet-cancel-button"
        onClick={cancel}
        {...keyboardButton(!resetting, cancel)}
      />
      <Button
        text={t('reset_wallet')}
        preset="danger"
        full
        disabled={!canReset}
        loading={resetting}
        aria-disabled={!canReset}
        data-testid="reset-wallet-confirm-button"
        onClick={() => void reset()}
        {...keyboardButton(canReset, () => void reset())}
      />
    </Row>
  );

  if (recoveryReasons) {
    return (
      <Popover onClose={resetting ? undefined : cancel} data-testid="reset-wallet-dialog">
        <KeyboardDialog label={t('reset_wallet_recovery_title')} onEscape={cancel}>
          <Column justifyCenter itemsCenter>
            {header}
            <RecoveryRiskConfirmation
              title={t('reset_wallet_recovery_title')}
              reasons={recoveryReasons}
              value={agreement}
              onChange={setAgreement}
              inputTestId="reset-wallet-recovery-confirmation-input"
            />
            {buttons}
          </Column>
        </KeyboardDialog>
      </Popover>
    );
  }

  return (
    <Popover onClose={resetting ? undefined : cancel} data-testid="reset-wallet-dialog">
      <KeyboardDialog label={t('reset_wallet')} onEscape={cancel}>
        <Column justifyCenter itemsCenter>
          {header}
          <Text text={t('reset_wallet')} preset="title-bold" textCenter />
          {lastWalletKey && (
            <Text
              text={t('reset_wallet_last_wallet')}
              preset="bold"
              textCenter
              data-testid="reset-wallet-last-wallet"
            />
          )}

          <Column gap="md" fullX>
            <Text text={t('reset_wallet_erases')} preset="sub" />
            <Text text={t('reset_wallet_keeps')} preset="sub" />
            <Text text={t('reset_wallet_restore_warning')} color="dangerText" />
          </Column>

          <Text text={t('this_action_is_not_reversible')} color="red_dark" />

          <Column fullX>
            <Input
              preset="password"
              placeholder={t('current_password')}
              aria-label={t('current_password')}
              value={password}
              autoFocus={true}
              disabled={resetting}
              data-testid="reset-wallet-password-input"
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
            />
            {/* Present before the message, so a screen reader announces it as it appears. */}
            <div role="alert">
              {error && <Text text={error} preset="regular" color="dangerText" data-testid="reset-wallet-error" />}
            </div>
          </Column>

          {buttons}
        </Column>
      </KeyboardDialog>
    </Popover>
  );
}
