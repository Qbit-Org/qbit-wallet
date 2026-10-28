import { Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { shortAddress } from '@/ui/utils';
import { ErrorCodes, QbitRecoveryRemovalReason, WalletKeyring } from '@qbit/wallet-shared';
import {
  accountActions,
  keyringsActions,
  useAppDispatch,
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

export const RemoveWalletPopover = ({ keyring, onClose }: { keyring: WalletKeyring; onClose: () => void }) => {
  const wallet = useWallet();
  const nav = useNavigation();
  const dispatch = useAppDispatch();
  const tools = useTools();
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
        const keyrings = await wallet.getKeyrings();
        dispatch(keyringsActions.setKeyrings(keyrings));

        if (nextKeyring) {
          dispatch(accountActions.setCurrent(nextKeyring.accounts[0]));
          return;
        }

        if (keyrings[0]) {
          dispatch(keyringsActions.setCurrent(keyrings[0]));
          return;
        }

        nav.navigate('WelcomeScreen');
      } catch (e) {
        // The keyring is already gone once removeKeyring resolves, so
        // a failed state refresh must not be reported as a refused
        // removal; keep the switch the background already made and
        // close the popover.
        if (nextKeyring) {
          dispatch(accountActions.setCurrent(nextKeyring.accounts[0]));
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
            />
          </Row>
        </Column>
      </Popover>
    );
  }

  return (
    <Popover onClose={removing ? undefined : cancel}>
      <Column justifyCenter itemsCenter>
        {header}
        <Text text={t('please_pay_attention_to_whether_you_have_backed_up')} textCenter />

        <Text text={t('this_action_is_not_reversible')} color="red_dark" />
        <Row full>
          <Button text={t('cancel')} full disabled={removing} onClick={cancel} />
          <Button
            text={t('remove')}
            preset="danger"
            full
            disabled={removing}
            onClick={async () => {
              await removeWallet(null);
            }}
          />
        </Row>
      </Column>
    </Popover>
  );
};
