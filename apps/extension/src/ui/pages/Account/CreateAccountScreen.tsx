import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { Button, Column, Content, Header, Input, Layout } from '@/ui/components';
import { WalletAvatar } from '@/ui/components/WalletIdentity';
import { walletErrorMessage } from '@/ui/utils';
import { MAX_ALIAS_NAME_LENGTH, WalletKeyring } from '@qbit/wallet-shared';
import {
  isEnterPressedInField,
  useCurrentKeyring,
  useI18n,
  useKeyrings,
  useNavigation,
  useReloadAccounts,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';
import './CreateAccountScreen.less';

/**
 * Derives one more account on a wallet and selects it. The account switcher
 * names the wallet it was opened for (`keyringKey`), which need not be the
 * current one; without one, the current wallet gets the account.
 */
export default function CreateAccountScreen() {
  const navigate = useNavigate();
  const nav = useNavigation();
  const wallet = useWallet();
  const tools = useTools();
  const reloadAccounts = useReloadAccounts();
  const currentKeyring = useCurrentKeyring();
  const keyrings = useKeyrings();
  const { keyringKey } = nav.getRouteState<'CreateAccountScreen'>() ?? {};
  const targetKeyring: WalletKeyring | undefined = keyringKey
    ? keyrings.find((keyring) => keyring.key === keyringKey)
    : currentKeyring;
  const walletNameId = useId();
  const [alianName, setAlianName] = useState('');
  const [defaultName, setDefaultName] = useState('');
  // On a mnemonic-restored wallet the derive RPC runs a full on-chain floor
  // scan and can take many seconds; without this guard every extra click or
  // Enter press queues one more account creation.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const { t } = useI18n();

  const handleOnClick = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    // The wallet the account goes to, as the store has it now; a named wallet
    // the store does not list (yet) is read from the background. Never
    // another wallet: a missing one ends the screen instead.
    let target = targetKeyring;
    if (!target && keyringKey) {
      try {
        target = (await wallet.getKeyrings()).find((keyring) => keyring.key === keyringKey);
      } catch {
        target = undefined;
      }
    }
    if (!target) {
      // Nothing was derived, so leaving is the only effect.
      tools.toastError(t('account_switcher_wallet_unavailable'));
      navigate('MainScreen');
      return;
    }
    try {
      const result = await wallet.deriveNewAccountFromMnemonic(target, alianName || defaultName);
      if (result?.floorScanPending) {
        // The account exists and is selected, but the restored keyring's
        // in-band signature-counter scan did not complete, so signing stays
        // locked until a later scan succeeds (next unlock or chain switch).
        // Say so in the user's language rather than echoing backend text.
        tools.toastWarning(t('qbit_restore_floors_incomplete_warning'));
      } else {
        tools.toastSuccess(t('success'));
      }
    } catch (e) {
      // A restored keyring commits and activates the new account before its
      // floor scan runs, so the RPC can reject with the account already
      // created (the keyring stays sign-locked and the deferred scan retries
      // later). No UI-side check can prove otherwise: the queued background
      // operation may still commit after a port drop rejects this request,
      // and a global account count can be masked by a concurrent keyring
      // removal. So once the derive has been dispatched the action is never
      // re-armed here; retrying would derive a duplicate account.
      tools.toastError(walletErrorMessage(e, t('unknown_error')));
    }
    // The derive selected the new account, possibly in another wallet than
    // the current one, so read the wallets and the selection back from the
    // background rather than from the object sent. Best effort: the screen is
    // left either way so a retry cannot derive a duplicate.
    try {
      await reloadAccounts();
    } catch {
      // The main screen keeps the last synced account until the next reload.
    }
    navigate('MainScreen');
  };

  // Enter in the name field creates the account, on its keydown: the account
  // switcher's "+" and Add account open this screen on an Enter's keydown.
  const handleOnKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (isEnterPressedInField(e)) {
      handleOnClick();
    }
  };

  const targetForName = targetKeyring?.key;
  useEffect(() => {
    if (!targetKeyring) return;
    let cancelled = false;
    wallet
      .getNextAlianName(targetKeyring)
      .then((accountName) => {
        if (!cancelled) setDefaultName(accountName);
      })
      .catch(() => {
        // Without a suggestion the background names the account itself.
      });
    return () => {
      cancelled = true;
    };
  }, [targetForName]);

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('new_account')}
      />
      <Content>
        <Column>
          {/* The new account's name under the wallet it goes to, as the account switcher
              lists an account under its wallet's header. */}
          <div>
            {targetKeyring && (
              <div className="create-account-wallet">
                <WalletAvatar keyring={targetKeyring} size={28} data-testid="create-account-wallet-tile" />
                <span
                  id={walletNameId}
                  className="create-account-wallet__name"
                  title={targetKeyring.alianName}
                  data-testid="create-account-wallet-name"
                >
                  {targetKeyring.alianName}
                </span>
              </div>
            )}
            <Input
              placeholder={defaultName}
              onChange={(e) => {
                setAlianName(e.target.value);
              }}
              onKeyDown={handleOnKeyDown}
              autoFocus={true}
              // The field takes focus first, so it names the wallet too.
              aria-describedby={targetKeyring ? walletNameId : undefined}
              data-testid="create-account-name-input"
              maxLength={MAX_ALIAS_NAME_LENGTH}
            />
          </div>
          <Button
            text={t('create_an_account')}
            preset="primary"
            loading={creating}
            onClick={(e) => {
              handleOnClick();
            }}
            data-testid="create-account-confirm-button"
          />
        </Column>
      </Content>
    </Layout>
  );
}
