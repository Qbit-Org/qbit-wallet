import { Card, Checkbox, Column, Icon, Row, Text, Tooltip } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import type { QbitSignatureBudgetImpact } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

type RestoredFloorRisk = NonNullable<QbitSignatureBudgetImpact['restoredFloorRisk']>;

export function QbitRestoredFloorWarning({
  risk,
  checked,
  onChange
}: {
  risk: RestoredFloorRisk;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <Card
      style={{
        backgroundColor: colors.warning_bg,
        border: `1px solid ${colors.warning_content}`
      }}
      data-testid="qbit-restored-floor-signing-warning"
    >
      <Column gap="sm" fullX>
        <Text text={t('qbit_recovery_signing_warning_title')} preset="bold" color="warning" />
        <Text text={t('qbit_recovery_status_seed_only')} />
        <Text text={t('qbit_counter_confidence_chain_floor_only')} />
        <Row itemsCenter gap="sm">
          <Text
            text={t(
              'qbit_known_onchain_usage_lower_bound',
              risk.knownOnChainSignatures > 0 ? `${risk.knownOnChainSignatures}+` : '0'
            )}
            data-testid="qbit-known-onchain-usage"
          />
          <Tooltip title={t('qbit_recovery_counter_approximate_tip')} overlayStyle={{ fontSize: fontSizes.xs }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <Icon icon="circle-question" color="textDim" size={12} />
            </div>
          </Tooltip>
        </Row>
        <Text text={t('qbit_recovery_signing_warning_body')} color="textDim" />
        <Checkbox
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          data-testid="qbit-restored-floor-signing-confirmation"
        >
          <Text text={t('qbit_recovery_signing_confirmation')} preset="sub-bold" />
        </Checkbox>
      </Column>
    </Card>
  );
}
