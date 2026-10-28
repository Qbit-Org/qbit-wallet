import { Column, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { useQbitDisplayLogic, useQbitUnit } from '@qbit/wallet-state';

type Presets = keyof typeof $viewPresets;

const $viewPresets = {
  main: {
    mainPartSize: 28,
    subPartSize: 20,
    unitPartSize: 20,
    mainPartColor: colors.onPrimary,
    subPartColor: colors.onPrimary,
    unitPartColor: colors.onPrimary,
    subPartMarginBottom: 2
  },
  sub: {
    mainPartSize: 12,
    subPartSize: 12,
    unitPartSize: 12,
    mainPartColor: colors.onPrimary,
    subPartColor: colors.onPrimary,
    unitPartColor: colors.onPrimary,
    subPartMarginBottom: 0
  }
};

export function QbitDisplay({
  balance,
  hideBalance,
  preset
}: {
  balance: string;
  hideBalance?: boolean;
  preset?: Presets;
}) {
  const qbitUnit = useQbitUnit();
  const $style = preset ? $viewPresets[preset] : $viewPresets['main'];

  const { totalAmountMainPart, totalAmountSubPart } = useQbitDisplayLogic(balance);

  const hiddenComponent = (
    <Column justifyCenter>
      <Text
        text={'****'}
        preset="title-bold"
        size="xxl"
        style={{
          fontSize: $style.mainPartSize,
          color: $style.mainPartColor
        }}
      />
    </Column>
  );

  const unitComponent = (
    <Column justifyCenter mx="sm">
      <Text
        text={qbitUnit}
        preset="title-bold"
        textCenter
        style={{
          fontSize: $style.unitPartSize,
          color: $style.unitPartColor,
          marginBottom: $style.subPartMarginBottom
        }}
      />
    </Column>
  );
  if (hideBalance) {
    return (
      <Row itemsCenter>
        {hiddenComponent}
        {preset !== 'sub' && unitComponent}
      </Row>
    );
  }

  return (
    <Row itemsEnd gap="zero">
      <Text
        text={totalAmountMainPart}
        preset="title-bold"
        style={{
          fontSize: $style.mainPartSize,
          color: $style.mainPartColor
        }}
      />
      <Text
        text={totalAmountSubPart}
        preset="title-bold"
        style={{
          fontSize: $style.subPartSize,
          color: $style.subPartColor,
          marginBottom: $style.subPartMarginBottom
        }}
      />
      {preset !== 'sub' && unitComponent}
    </Row>
  );
}
