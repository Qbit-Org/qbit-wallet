import { colors } from '@/ui/theme/colors';
import { useI18n } from '@qbit/wallet-state';

import { DecodedPsbt } from '@qbit/wallet-shared';
import { Column } from '../Column';
import { FeeRateBar } from '../FeeRateBar';
import { Icon } from '../Icon';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';

export const BadFeeRate = ({
  decodedPsbt,
  riskContentKey,
  onClose
}: {
  decodedPsbt: DecodedPsbt;
  riskContentKey: {
    title: string;
    description: string;
  };
  onClose: () => void;
}) => {
  const { t } = useI18n();
  return (
    <Popover>
      <Column justifyCenter itemsCenter>
        <Row fullX justifyBetween>
          <Row />
          <Text text={t(riskContentKey.title)} preset="bold" />
          <Icon
            icon="close"
            onClick={() => {
              onClose();
            }}
          />
        </Row>

        <Row fullX style={{ borderBottomWidth: 1, borderColor: colors.border }} />

        <Text text={t('current_fee_rate')} preset="sub" />
        <Text text={`${Number(decodedPsbt.feeRate.toFixed(2))} bits/vB`} />

        <Text text={t('recommended_fee_rates')} preset="sub" mt="lg" />
        <FeeRateBar readonly />
      </Column>
    </Popover>
  );
};
