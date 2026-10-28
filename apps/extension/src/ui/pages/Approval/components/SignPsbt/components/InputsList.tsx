import { Card, Column, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { DecodedPsbt, ToSignData } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';
import { InputItem } from './InputItem';

export function InputsList({
  toSignData,
  decodedPsbt
}: {
  toSignData: ToSignData;
  decodedPsbt: DecodedPsbt;
}) {
  const { t } = useI18n();
  const inputInfos = decodedPsbt.inputInfos;

  return (
    <Column>
      <Card
        mt="sm"
        style={{
          backgroundColor: 'var(--qbit-paper)'
        }}
      >
        <Column full justifyCenter>
          <Row itemsCenter gap="sm" mb="sm">
            <Text text={t('inputs')} color="textDim" />
            <Row
              style={{
                padding: '1px 8px',
                backgroundColor: colors.surfaceMuted,
                border: `1px solid ${colors.border}`,
                borderRadius: 999
              }}
            >
              <Text text={String(inputInfos.length)} size="xs" color="textDim" />
            </Row>
          </Row>

          {decodedPsbt.inputInfos.map((v, index) => {
            return (
              <InputItem
                key={index}
                inputInfo={v}
                index={index}
                decodedPsbt={decodedPsbt}
                toSignData={toSignData}
              />
            );
          })}
        </Column>
      </Card>
    </Column>
  );
}
