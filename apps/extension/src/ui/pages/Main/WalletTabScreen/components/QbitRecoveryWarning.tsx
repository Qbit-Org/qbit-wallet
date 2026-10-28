import { useState, type CSSProperties } from 'react';

import { Button, Card, Checkbox, Column, Icon, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import type { QbitRecoveryState } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

const $warningCardStyle: CSSProperties = {
  border: `1px solid ${colors.warning_content}`,
  backgroundColor: 'rgba(244, 182, 44, 0.08)'
};

export function QbitRecoveryWarning({
  state,
  accepted,
  onAcceptedChange,
  onAcknowledge,
  onMoveFunds,
  onDismiss
}: {
  state: QbitRecoveryState;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  onAcknowledge: () => void;
  onMoveFunds: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const confirmedPlans = state.migration?.plans.filter((plan) => plan.status === 'confirmed').length || 0;
  const totalPlans = state.migration?.plans.length || 0;

  if (state.status === 'clean') return null;

  if (state.status === 'migrated') {
    return (
      <Card data-testid="qbit-recovery-archived" style={$warningCardStyle}>
        <Column gap="lg" fullX>
          <Text text={t('qbit_recovery_archived_title')} preset="bold" color="warning" />
          <Text text={t('qbit_recovery_archived_body')} color="textDim" />
          {state.otherNetworksPendingRecovery ? (
            <Text
              text={t('qbit_recovery_other_networks_hint')}
              color="warning"
              data-testid="qbit-recovery-other-networks-hint"
            />
          ) : null}
          <Button
            preset="defaultV2"
            text={t('qbit_recovery_check_new_funds')}
            onClick={onMoveFunds}
            data-testid="qbit-recovery-resume-button"
          />
        </Column>
      </Card>
    );
  }

  if (state.status === 'migrating') {
    return (
      <Card data-testid="qbit-recovery-migrating">
        <Column gap="sm" fullX>
          <Text text={t('qbit_recovery_migrating_title')} preset="bold" color="warning" />
          <Text text={t('qbit_recovery_migrating_body')} color="textDim" />
          {state.migration?.destinationAddress ? (
            <Text text={t('qbit_recovery_destination_value', state.migration.destinationAddress)} wrap selectText />
          ) : null}
          <Text text={t('qbit_recovery_progress', [confirmedPlans.toString(), totalPlans.toString()])} />
          <Button
            preset="primary"
            text={t('qbit_recovery_resume_migration')}
            onClick={onMoveFunds}
            data-testid="qbit-recovery-resume-button"
          />
        </Column>
      </Card>
    );
  }

  if (state.acknowledgement === 'accepted') {
    // Continued use is confirmed; the warning shrinks to a residual banner
    // the user can expand for the full guidance or permanently dismiss.
    if (state.warningDismissed) return null;
    return (
      <Card data-testid="qbit-recovery-warning" style={$warningCardStyle}>
        <Column gap="lg" fullX>
          <Row
            full
            justifyBetween
            itemsCenter
            onClick={() => setExpanded((value) => !value)}
            style={{ cursor: 'pointer' }}
            data-testid="qbit-recovery-warning-toggle"
          >
            <Text text={t('qbit_recovery_warning_collapsed_title')} preset="bold" color="warning" />
            <Icon icon={expanded ? 'up' : 'down'} color="warning" size={12} />
          </Row>
          {expanded ? (
            <>
              <Text text={t('qbit_recovery_warning_body')} color="textDim" />
              <Text text={t('qbit_recovery_warning_recommendation')} preset="bold" />
              {!state.migration ? (
                <Button
                  preset="primary"
                  text={t('qbit_recovery_move_funds')}
                  onClick={onMoveFunds}
                  full
                  data-testid="qbit-recovery-move-funds-button"
                />
              ) : null}
              <Button
                preset="defaultV2"
                text={t('qbit_recovery_dismiss_warning')}
                onClick={onDismiss}
                full
                data-testid="qbit-recovery-dismiss-button"
              />
            </>
          ) : null}
        </Column>
      </Card>
    );
  }

  return (
    <Card data-testid="qbit-recovery-warning" style={$warningCardStyle}>
      <Column gap="lg" fullX>
        <Text text={t('qbit_recovery_warning_title')} preset="bold" color="warning" />
        <Text text={t('qbit_recovery_warning_body')} color="textDim" />
        <Text text={t('qbit_recovery_warning_recommendation')} preset="bold" />
        {!state.migration ? (
          <Button
            preset="primary"
            text={t('qbit_recovery_move_funds')}
            onClick={onMoveFunds}
            full
            data-testid="qbit-recovery-move-funds-button"
          />
        ) : null}
        {!state.migration ? (
          <Row full itemsCenter gap="md">
            <Row style={{ flex: 1, height: 1, backgroundColor: colors.line2 }} />
            <Text text={t('qbit_recovery_or_divider')} preset="sub" />
            <Row style={{ flex: 1, height: 1, backgroundColor: colors.line2 }} />
          </Row>
        ) : null}
        <Checkbox
          checked={accepted}
          onChange={(event) => onAcceptedChange(event.target.checked)}
          data-testid="qbit-recovery-continued-use-checkbox"
        >
          <Text text={t('qbit_recovery_continue_confirmation')} preset="sub-bold" />
        </Checkbox>
        <Button
          preset="defaultV2"
          text={t('qbit_recovery_continue_using')}
          disabled={!accepted}
          onClick={onAcknowledge}
          full
          data-testid="qbit-recovery-acknowledge-button"
        />
      </Column>
    </Card>
  );
}
