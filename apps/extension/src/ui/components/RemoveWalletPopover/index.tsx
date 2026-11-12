import { Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { shortAddress } from '@/ui/utils';
import { activateOnKey, keepTabInside } from '@/ui/utils/keyboard';
import { Account, ErrorCodes, QbitRecoveryRemovalReason, WalletKeyring } from '@qbit/wallet-shared';
import {
  accountActions,
  keyringsActions,
  useAppDispatch,
  useCurrentAccount,
  useI18n,
  useNavigation,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import { Button } from '../Button';
import { Card } from '../Card';
import { Column } from '../Column';
import { Input } from '../Input';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';

const AGREEMENT_TEXT = 'CONFIRM';

// Maps removal reasons to risk lines, deduplicated so a wallet migrating on
// several networks reads as one risk rather than one per network.
function riskMessageKeys(reasons: QbitRecoveryRemovalReason[]): string[] {
  const keys: string[] = [];
  const push = (key: string) => {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  };
  for (const reason of reasons) {
    if (reason.role === 'source') {
      push(
        reason.status === 'migrated'
          ? 'qbit_recovery_removal_source_migrated'
          : 'qbit_recovery_removal_source_migrating'
      );
    } else if (reason.role === 'destination') {
      push('qbit_recovery_removal_destination');
    } else {
      push('qbit_recovery_removal_unverified');
    }
    if (reason.hasInflightPlans) {
      push('qbit_recovery_removal_inflight');
    }
  }
  if (keys.length === 0) {
    // The background refused without detail; show the broadest warning.
    push('qbit_recovery_removal_unverified');
  }
  return keys;
}

/**
 * Takes focus when the popover opens, keeps Tab inside it and cancels on
 * Escape, so the popover works without a pointer.
 */
function KeyboardDialog({
  label,
  onEscape,
  children
}: {
  label: string;
  onEscape: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{ outline: 'none' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
          return;
        }
        keepTabInside(event, ref.current);
      }}>
      {children}
    </div>
  );
}

/** Keyboard access for the popover's buttons, which render as divs. */
const keyboardButton = (enabled: boolean, activate: () => void) => ({
  role: 'button',
  tabIndex: enabled ? 0 : -1,
  onKeyDown: activateOnKey(activate)
});

export const RemoveWalletPopover = ({ keyring, onClose }: { keyring: WalletKeyring; onClose: () => void }) => {
  const wallet = useWallet();
  const nav = useNavigation();
  const dispatch = useAppDispatch();
  const tools = useTools();
  const currentAccount = useCurrentAccount();
  const displayAddress = useMemo(() => {
    if (!keyring.accounts[0]) {
      return 'Invalid';
    }
    const address = keyring.accounts[0].address;
    return shortAddress(address);
  }, []);
  const { t } = useI18n();

  // Non-null once the background reported that this removal touches an
  // active recovery migration and asked for an explicit risk confirmation.
  const [recoveryReasons, setRecoveryReasons] = useState<QbitRecoveryRemovalReason[] | null>(null);
  const [inputValue, setInputValue] = useState('');
  const understand = inputValue.toUpperCase() === AGREEMENT_TEXT;

  // Buttons are plain divs and state lands only on the next render, so a
  // double-click (or a cancel racing the removal) needs the ref to be
  // refused synchronously; the state drives the disabled visuals.
  const removingRef = useRef(false);
  const [removing, setRemoving] = useState(false);

  const cancel = () => {
    if (!removingRef.current) {
      onClose();
    }
  };

  // The account selected in `next`, the wallet current after the removal,
  // when the background cannot tell: the one shown now if `next` holds it
  // (another wallet was removed, which leaves the current account as it is),
  // else its first account (the background switched to `next`).
  const accountShownIn = (next: WalletKeyring) =>
    next.accounts.find((candidate) => candidate.key === currentAccount.key) ?? next.accounts[0];

  // Whether `candidate` holds `account` as the background has it now: the
  // same account, at the same address.
  const holds = (candidate: WalletKeyring | null | undefined, account: Account | null): account is Account =>
    !!candidate &&
    !!account &&
    candidate.accounts.some((held) => held.key === account.key && held.address === account.address);

  // Whether `candidate` can be opened: not corrupted, with an account to
  // select. The switcher lists any other wallet as Invalid.
  const isUsable = (candidate: WalletKeyring) =>
    (candidate as WalletKeyring & { isCorrupted?: boolean }).isCorrupted !== true && candidate.accounts.length > 0;

  const removeWallet = async (acknowledgedReasons: QbitRecoveryRemovalReason[] | null) => {
    if (removingRef.current) {
      return;
    }
    removingRef.current = true;
    setRemoving(true);
    try {
      let nextKeyring: WalletKeyring | undefined;
      try {
        nextKeyring = await wallet.removeKeyring(
          keyring,
          acknowledgedReasons
            ? {
                acknowledgedQbitRecoveryRisks: true,
                acknowledgedQbitRecoveryReasons: acknowledgedReasons
              }
            : undefined
        );
      } catch (e) {
        const error = e as {
          code?: unknown;
          message?: string;
          data?: { reasons?: QbitRecoveryRemovalReason[] };
        };
        if (error?.code === ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED) {
          // The wallet is part of a recovery migration: keep the popover open
          // and collect an explicit risk confirmation instead of refusing. A
          // confirmed retry lands here again only when the risks changed while
          // the warning was open, so the refreshed reason list must be
          // re-confirmed from scratch.
          setRecoveryReasons(error.data?.reasons ?? []);
          setInputValue('');
          return;
        }
        tools.toastError(error?.message || t('unknown_error'));
        onClose();
        return;
      }

      try {
        // The removed wallet's slot stays empty for good: a wallet listed
        // under its key is that wallet as a read that started before the
        // removal had it. It is neither shown nor made current, so the store
        // loses it, and the switcher, which shows this popover only for a
        // wallet in the store, closes the popover.
        const isRemoved = (candidate: WalletKeyring | null | undefined) => candidate?.key === keyring.key;
        const keyrings = (await wallet.getKeyrings()).filter((candidate) => !isRemoved(candidate));
        // A lock can land while the removal is saved. The wallets then read
        // as none, though the vault still holds them: leave the store's
        // wallets as they are and ask for the password, as the app does on a
        // lock, rather than show no wallets or offer to create one.
        if (!(await wallet.isUnlocked())) {
          nav.navToLock({ autoUnlockByFace: false });
          return;
        }

        // The background returns the wallet current after the removal: the
        // one that was, with its account, when another wallet was removed,
        // or else the wallet it switched to, with its first account. The
        // store follows with that wallet and the account the background has
        // selected in it, read before anything is shown.
        const selected: Account | null = await wallet.getCurrentAccount().catch(() => null);
        let current: WalletKeyring | null | undefined = nextKeyring;
        if (selected && !holds(current, selected)) {
          // The account is not in that wallet: another window switched since
          // (or kept adding wallets while the removal read them, so it
          // returned none). The store follows the background: the wallet
          // current now, read back, or else the wallet read that holds the
          // account.
          const readBack = await wallet.getCurrentKeyring().catch(() => null);
          current =
            (isRemoved(readBack) ? null : readBack) ??
            keyrings.find((candidate) => holds(candidate, selected)) ??
            current;
        }
        // Nothing read says which wallet is current: the removal returned
        // none, and the account selected could not be read, or is in no
        // wallet read. A failed read is not "no wallets": like the removal
        // when the current wallet goes, the store shows the last usable
        // wallet read, with its own account.
        current = current ?? keyrings.filter(isUsable).pop();

        // Dispatched together, with no wait in between, so no render shows
        // one wallet with another wallet's account, or the wallets left with
        // the removed one still current.
        dispatch(keyringsActions.setKeyrings(keyrings));
        if (current) {
          dispatch(keyringsActions.setCurrent(current));
          // A wallet that does not hold the account read (the background
          // switched again before it was read back) is shown with its own.
          dispatch(accountActions.setCurrent(holds(current, selected) ? selected : accountShownIn(current)));
          return;
        }

        // No wallet read can be opened: like the app with no wallet to open,
        // go to the welcome screen rather than make a corrupted wallet
        // current.
        nav.navigate('WelcomeScreen');
      } catch (e) {
        // The keyring is already gone once removeKeyring resolves, so
        // a failed state refresh must not be reported as a refused
        // removal; show the wallet the background left current and
        // close the popover.
        if (nextKeyring) {
          dispatch(keyringsActions.setCurrent(nextKeyring));
          dispatch(accountActions.setCurrent(accountShownIn(nextKeyring)));
        }
        onClose();
      }
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  const header = (
    <>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '1.5rem',
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'row',
          backgroundColor: '#CC3333',
          justifyContent: 'center'
        }}>
        <Trash2 style={{ height: '1rem', width: '1rem' }} />
      </div>

      <Card preset="style2" style={{ width: 200 }}>
        <Column>
          <Text text={keyring.alianName} textCenter />
          <Text text={displayAddress} preset="sub" textCenter />
        </Column>
      </Card>
    </>
  );

  if (recoveryReasons) {
    return (
      <Popover onClose={removing ? undefined : cancel}>
        <KeyboardDialog label={t('qbit_recovery_removal_title')} onEscape={cancel}>
          <Column justifyCenter itemsCenter>
            {header}
            <Text text={t('qbit_recovery_removal_title')} preset="title-bold" textCenter />

            <Column gap="md" fullX mb="md">
              {riskMessageKeys(recoveryReasons).map((key) => (
                <Text key={key} text={t(key)} preset="sub" />
              ))}
            </Column>

            <Text text={t('this_action_is_not_reversible')} color="red_dark" />

            <Column fullX>
              <Text text={`${t('enter')} “${AGREEMENT_TEXT}” ${t('to_proceed')}`} preset="bold" />
              <Input
                preset="text"
                autoFocus={true}
                value={inputValue}
                data-testid="recovery-removal-confirmation-input"
                onChange={(e) => {
                  setInputValue(e.target.value);
                }}
              />
            </Column>

            <Row full>
              <Button
                text={t('cancel')}
                full
                disabled={removing}
                data-testid="recovery-removal-cancel-button"
                onClick={cancel}
                {...keyboardButton(!removing, cancel)}
              />
              <Button
                text={t('remove')}
                preset="danger"
                disabled={!understand || removing}
                aria-disabled={!understand || removing}
                data-testid="recovery-removal-confirm-button"
                full
                onClick={async () => {
                  if (!understand) {
                    return;
                  }
                  await removeWallet(recoveryReasons);
                }}
                {...keyboardButton(understand && !removing, () => {
                  if (understand) {
                    void removeWallet(recoveryReasons);
                  }
                })}
              />
            </Row>
          </Column>
        </KeyboardDialog>
      </Popover>
    );
  }

  return (
    <Popover onClose={removing ? undefined : cancel}>
      <KeyboardDialog label={t('remove_wallet')} onEscape={cancel}>
        <Column justifyCenter itemsCenter>
          {header}
          <Text text={t('please_pay_attention_to_whether_you_have_backed_up')} textCenter />

          <Text text={t('this_action_is_not_reversible')} color="red_dark" />
          <Row full>
            <Button
              text={t('cancel')}
              full
              disabled={removing}
              onClick={cancel}
              {...keyboardButton(!removing, cancel)}
            />
            <Button
              text={t('remove')}
              preset="danger"
              full
              disabled={removing}
              onClick={async () => {
                await removeWallet(null);
              }}
              {...keyboardButton(!removing, () => void removeWallet(null))}
            />
          </Row>
        </Column>
      </KeyboardDialog>
    </Popover>
  );
};
