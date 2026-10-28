import { Card, Column, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { DecodedPsbt } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';
import { InputItem } from './InputItem';

export function OutputsList({ decodedPsbt }: { decodedPsbt: DecodedPsbt }) {
  const { t } = useI18n();
  const outputInfos = decodedPsbt.outputInfos;

  return (
    <Column>
      <Card
        mt="sm"
        style={{
          backgroundColor: 'var(--qbit-paper)'
        }}
      >
        <Column full justifyCenter>
          <Row itemsCenter gap="sm" mb="lg">
            <Text text={t('outputs')} color="textDim" />
            <Row
              style={{
                padding: '1px 8px',
                backgroundColor: colors.surfaceMuted,
                border: `1px solid ${colors.border}`,
                borderRadius: 999
              }}
            >
              <Text text={String(outputInfos.length)} size="xs" color="textDim" />
            </Row>
          </Row>

          {decodedPsbt.outputInfos.map((v, index) => {
            return (
              <InputItem
                key={index}
                outputInfo={v}
                index={index}
                decodedPsbt={decodedPsbt}
              />
            );
          })}
        </Column>
      </Card>
    </Column>
  );
}
