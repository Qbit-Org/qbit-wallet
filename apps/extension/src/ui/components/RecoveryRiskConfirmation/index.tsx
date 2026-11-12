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

// Maps removal reasons to risk lines, deduplicated so a wallet migrating on
// several networks reads as one risk rather than one per network.
export function riskMessageKeys(reasons: QbitRecoveryRemovalReason[]): string[] {
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
      push('qbit_recovery_removal_unverified');
      continue;
    }
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
 * The risk step of a wallet removal or a reset that touches a Qbit recovery
 * migration: the risks the background reported, and the typed agreement that
 * acknowledges them. The dialog keeps its own buttons.
 */
export function RecoveryRiskConfirmation({
  title,
  reasons,
  value,
  onChange,
  inputTestId
}: {
  title: string;
  reasons: QbitRecoveryRemovalReason[];
  value: string;
  onChange: (value: string) => void;
  inputTestId: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <Text text={title} preset="title-bold" textCenter />

      <Column gap="md" fullX mb="md">
        {riskMessageKeys(reasons).map((key) => (
          <Text key={key} text={t(key)} preset="sub" />
        ))}
      </Column>

      <Text text={t('this_action_is_not_reversible')} color="red_dark" />

      <Column fullX>
        <Text text={`${t('enter')} “${RECOVERY_RISK_AGREEMENT_TEXT}” ${t('to_proceed')}`} preset="bold" />
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
