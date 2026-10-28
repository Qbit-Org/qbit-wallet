import { Card, Column, Icon, Row, Text, Tooltip } from '@/ui/components';
import { ColorTypes } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { DecodedPsbt, ToSignData } from '@qbit/wallet-shared';
import { useI18n, useQbitUnit } from '@qbit/wallet-state';

import { SignPsbtSection } from './Section';

interface TransactionOverviewSectionProps {
  decodedPsbt: DecodedPsbt;
  networkFee: any;
  toSignData?: ToSignData;
}

export default function TransactionOverviewSection({ decodedPsbt, networkFee, toSignData }: TransactionOverviewSectionProps) {
  const qbitUnit = useQbitUnit();
  const { t } = useI18n();

  const signatureBudget = toSignData?.signatureBudget;

  const getFeeRateColor = (): ColorTypes => {
    if (!decodedPsbt.shouldWarnFeeRate) return 'text';
    return decodedPsbt.recommendedFeeRate > decodedPsbt.feeRate ? 'warning' : 'dangerText';
  };

  const title = t('network_fees');

  const showNetworkFee = decodedPsbt.isCompleted == true;

  if (showNetworkFee === false) {
    return null;
  }

  return (
    <SignPsbtSection title={title}>
      <Column gap="sm">
        <Card
          mt="zero"
          style={{
            borderWidth: 1,
            borderColor: 'var(--qbit-line)',
            borderRadius: 0
          }}
        >
          <Row justifyBetween itemsCenter fullX>
            <Text text={t('network_fee_2')} color="textDim" size="sm" />
            <Text text={networkFee.toString() + ' ' + qbitUnit} preset="bold" size="sm" />
          </Row>
        </Card>

        <Card
          mt="zero"
          style={{
            borderWidth: 1,
            borderColor: 'var(--qbit-line)',
            borderRadius: 0
          }}
        >
          <Row justifyBetween itemsCenter fullX>
            <Text text={t('fee_rate')} color="textDim" size="sm" />
            <Column gap="zero" style={{ alignItems: 'flex-end' }}>
              <Text text={`${decodedPsbt.feeRate} bits/vB`} preset="bold" size="sm" color={getFeeRateColor()} />
              <Text
                data-testid="psbt-network-fee-base-units"
                text={`Exact fee: ${decodedPsbt.fee} bits`}
                size="xs"
                color="textDim"
              />
            </Column>
          </Row>
        </Card>

        {signatureBudget && (
          <Column gap="sm" fullX data-testid="psbt-signature-budget">
            <Text
              text={`Signatures: ${signatureBudget.required} new • ${signatureBudget.cached} cached`}
              size="xs"
              color="textDim"
            />
            {signatureBudget.restoredFloorRisk ? (
              <Row itemsCenter gap="sm">
                <Text
                  text={t(
                    'qbit_known_onchain_usage_lower_bound',
                    signatureBudget.restoredFloorRisk.knownOnChainSignatures > 0
                      ? `${signatureBudget.restoredFloorRisk.knownOnChainSignatures}+`
                      : '0'
                  )}
                  size="xs"
                  color="textDim"
                />
                <Tooltip title={t('qbit_recovery_counter_approximate_tip')} overlayStyle={{ fontSize: fontSizes.xs }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <Icon icon="circle-question" color="textDim" size={12} />
                  </div>
                </Tooltip>
              </Row>
            ) : (
              <Text
                text={`Signature budget: ${signatureBudget.remainingBefore} before, ${signatureBudget.remainingAfter} after`}
                size="xs"
                color="textDim"
              />
            )}
          </Column>
        )}
      </Column>
    </SignPsbtSection>
  );
}
