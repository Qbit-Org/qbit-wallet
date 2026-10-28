import { useEffect, useState } from 'react';

import { Button, Column, Content, Header, Input, Layout } from '@/ui/components';
import { walletErrorMessage } from '@/ui/utils';
import { MAX_ALIAS_NAME_LENGTH } from '@qbit/wallet-shared';
import { useCurrentKeyring, useI18n, useSetCurrentAccountCallback, useTools, useWallet } from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

export default function CreateAccountScreen() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const tools = useTools();
  const setCurrentAccount = useSetCurrentAccountCallback();
  const currentKeyring = useCurrentKeyring();
  const [alianName, setAlianName] = useState('');
  const [defaultName, setDefaultName] = useState('');
  // On a mnemonic-restored wallet the derive RPC runs a full on-chain floor
  // scan and can take many seconds; without this guard every extra click or
  // Enter press queues one more account creation.
  const [creating, setCreating] = useState(false);
  const { t } = useI18n();
  const handleOnClick = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const result = await wallet.deriveNewAccountFromMnemonic(currentKeyring, alianName || defaultName);
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
    // Best-effort sync of the current account (AccountUpdater reloads the
    // account list when the current key changes); the screen is left either
    // way so a retry cannot derive a duplicate.
    try {
      setCurrentAccount(await wallet.getCurrentAccount());
    } catch {
      // The main screen keeps the last synced account until the next reload.
    }
    navigate('MainScreen');
  };

  const handleOnKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ('Enter' == e.key) {
      handleOnClick();
    }
  };

  const init = async () => {
    const accountName = await wallet.getNextAlianName(currentKeyring);
    setDefaultName(accountName);
  };
  useEffect(() => {
    init();
  }, []);

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
          <Input
            placeholder={defaultName}
            onChange={(e) => {
              setAlianName(e.target.value);
            }}
            onKeyUp={(e) => handleOnKeyUp(e as any)}
            autoFocus={true}
            data-testid="create-account-name-input"
            maxLength={MAX_ALIAS_NAME_LENGTH}
          />
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
