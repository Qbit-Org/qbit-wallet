import { QbitRecoveryRemovalReason } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import { Column } from '../Column';
import { Input } from '../Input';
import { Text } from '../Text';

/** What the user types to acknowledge the recovery risks of removing wallets. */
export const RECOVERY_RISK_AGREEMENT_TEXT = 'CONFIRM';

export function isRecoveryRiskAgreementTyped(value: string): boolean {
  return value.toUpperCase() === RECOVERY_RISK_AGREEMENT_TEXT;
}

/** The message key of each risk line, in the words of the dialog that shows them. */
export interface RecoveryRiskMessageKeys {
  sourceMigrating: string;
  sourceMigrated: string;
  destination: string;
  inflight: string;
  unverified: string;
}

/** The removal dialog's risk lines: they speak of the one wallet removed. */
export const RECOVERY_REMOVAL_RISK_KEYS: RecoveryRiskMessageKeys = {
  sourceMigrating: 'qbit_recovery_removal_source_migrating',
  sourceMigrated: 'qbit_recovery_removal_source_migrated',
  destination: 'qbit_recovery_removal_destination',
  inflight: 'qbit_recovery_removal_inflight',
  unverified: 'qbit_recovery_removal_unverified'
};

/** The reset dialog's risk lines: the same risks, for a wallet among all those a reset erases. */
export const RECOVERY_RESET_RISK_KEYS: RecoveryRiskMessageKeys = {
  sourceMigrating: 'reset_wallet_recovery_source_migrating',
  sourceMigrated: 'reset_wallet_recovery_source_migrated',
  destination: 'reset_wallet_recovery_destination',
  inflight: 'reset_wallet_recovery_inflight',
  unverified: 'reset_wallet_recovery_unverified'
};

// Maps removal reasons to risk lines, in the words of `messageKeys` (the
// removal's by default), deduplicated so a wallet migrating on several
// networks reads as one risk rather than one per network.
export function riskMessageKeys(
  reasons: QbitRecoveryRemovalReason[],
  messageKeys: RecoveryRiskMessageKeys = RECOVERY_REMOVAL_RISK_KEYS
): string[] {
  const keys: string[] = [];
  const push = (key: string) => {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  };
  for (const reason of reasons) {
    // The reasons cross the UI port as JSON; one that is not an object
    // carries no detail, so it reads as the broadest warning.
    if (typeof reason !== 'object' || reason === null) {
      push(messageKeys.unverified);
      continue;
    }
    if (reason.role === 'source') {
      push(reason.status === 'migrated' ? messageKeys.sourceMigrated : messageKeys.sourceMigrating);
    } else if (reason.role === 'destination') {
      push(messageKeys.destination);
    } else {
      push(messageKeys.unverified);
    }
    if (reason.hasInflightPlans) {
      push(messageKeys.inflight);
    }
  }
  if (keys.length === 0) {
    // The background refused without detail; show the broadest warning.
    push(messageKeys.unverified);
  }
  return keys;
}

/**
 * The risk step of a wallet removal or a reset that touches a Qbit recovery
 * migration: the risks the background reported, and the typed agreement that
 * acknowledges them. The dialog keeps its own buttons.
 *
 * The dialog chooses the words of the risk lines (`messageKeys`, the
 * removal's by default) and the presentation: `start`, the removal dialog's,
 * by default, with the title alone centered; or `centered`, the reset
 * dialog's, with every text centered and "not reversible" in bold, as on its
 * password step.
 */
export function RecoveryRiskConfirmation({
  title,
  reasons,
  value,
  onChange,
  inputTestId,
  messageKeys = RECOVERY_REMOVAL_RISK_KEYS,
  presentation = 'start'
}: {
  title: string;
  reasons: QbitRecoveryRemovalReason[];
  value: string;
  onChange: (value: string) => void;
  inputTestId: string;
  messageKeys?: RecoveryRiskMessageKeys;
  presentation?: 'start' | 'centered';
}) {
  const { t } = useI18n();
  const centered = presentation === 'centered';
  return (
    <>
      <Text text={title} preset="title-bold" textCenter />

      <Column gap="md" fullX mb="md">
        {riskMessageKeys(reasons, messageKeys).map((key) => (
          <Text key={key} text={t(key)} preset="sub" textCenter={centered} />
        ))}
      </Column>

      <Text
        text={t('this_action_is_not_reversible')}
        preset={centered ? 'bold' : undefined}
        color="red_dark"
        textCenter={centered}
      />

      <Column fullX>
        <Text
          text={`${t('enter')} “${RECOVERY_RISK_AGREEMENT_TEXT}” ${t('to_proceed')}`}
          preset="bold"
          textCenter={centered}
        />
        <Input
          preset="text"
          autoFocus={true}
          value={value}
          data-testid={inputTestId}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </Column>
    </>
  );
}
