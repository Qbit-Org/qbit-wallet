import { useEffect, useState } from 'react';

import { colors } from '@/ui/theme/colors';
import type { FeeSummary } from '@qbit/wallet-shared';
import { useChainType, useI18n, useWallet } from '@qbit/wallet-state';

import { Card } from '../Card';
import { Column } from '../Column';
import { Icon } from '../Icon';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';
import { Tooltip } from '../Tooltip';

enum FeeRateType {
  SLOW,
  AVG,
  FAST,
  CUSTOM
}

const FEE_TITLES = ['low_priority', 'medium_priority', 'high_priority'];
const FEE_ICONS = ['fee-low', 'fee-medium', 'fee-high'] as const;

interface FeeOption {
  title: string;
  desc?: string;
  feeRate: number;
}
export function FeeRateIcon() {
  const wallet = useWallet();
  const { t } = useI18n();
  const [feeSummary, setFeeSummary] = useState<FeeSummary>();

  const [feeOptionVisible, setFeeOptionVisible] = useState(false);

  const chainType = useChainType();
  useEffect(() => {
    wallet.getFeeSummary().then((v) => {
      setFeeSummary(v);
    });
  }, [chainType]);

  const feeOptions = feeSummary?.list ?? [];
  const feeEstimateUnavailable = feeSummary?.quote?.availability === 'unavailable';
  const feeRate = !feeEstimateUnavailable && feeOptions[FeeRateType.AVG] ? feeOptions[FeeRateType.AVG].feeRate : 0;

  let color = 'textDim';
  if (feeRate > 100) {
    color = 'dangerText';
  } else if (feeRate > 20) {
    color = 'warning';
  } else if (feeRate > 0) {
    color = 'green';
  }
  return (
    <>
      <Tooltip
        title={t('network_fees')}
        overlayStyle={{
          minWidth: '70px',
          fontSize: '12px'
        }}
        placement="bottom"
      >
        <Card
          preset="style2"
          onClick={
            feeEstimateUnavailable
              ? undefined
              : () => {
                  setFeeOptionVisible(true);
                }
          }
          style={{
            backgroundColor: colors.surface,
            height: 28,
            borderRadius: 0,
            // Padding matches the style2 wallet pill (4px vertical, 12px
            // horizontal) so the header pills render at the same size.
            padding: '4px 12px',
            gap: 2,
            cursor: feeEstimateUnavailable ? 'default' : 'pointer'
          }}
        >
          <Icon icon="gas" />
          <Text text={feeRate > 0 ? feeRate : '-'} size="xxs" color={color as any} />
        </Card>
      </Tooltip>

      {/* Rendered outside the clickable card so clicks inside the popover
          (including its close button) cannot bubble into the opener. */}
      {feeOptionVisible && !feeEstimateUnavailable ? (
        <FeeOptionsPopover
          feeOptions={feeOptions}
          onClose={() => {
            setFeeOptionVisible(false);
          }}
        />
      ) : null}
    </>
  );
}

function FeeOptionsPopover({ feeOptions, onClose }: { feeOptions: FeeOption[]; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Popover onClose={onClose}>
      <Column>
        <Row style={{ marginBottom: 10 }}>
          <Text text={t('network_fees')} preset="bold" />
        </Row>
        {feeOptions.map((v, i) => {
          return (
            <Card
              key={i}
              mb="sm"
              preset="style1"
              itemsCenter
              style={{
                height: 50,
                minHeight: 50,
                backgroundColor: colors.surfaceMuted
              }}
            >
              <Row justifyBetween full itemsCenter>
                <Row itemsCenter>
                  {FEE_ICONS[i] && (
                    <Icon icon={FEE_ICONS[i]} size={16} color="textDim" data-testid={`fee-priority-${FEE_ICONS[i]}`} />
                  )}
                  <Text color={'textDim'} size="sm" text={t(FEE_TITLES[i] || v.title)}></Text>
                </Row>

                <Row>
                  <Text color="text" size="sm" text={v.feeRate}></Text>
                  <Text color={'textDim'} size="sm" text="bits/vB"></Text>
                </Row>
              </Row>
            </Card>
          );
        })}
      </Column>
    </Popover>
  );
}
