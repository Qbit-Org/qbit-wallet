import { Column, Row, Text } from '@/ui/components';
import { BalanceFigure } from '@/ui/components/BalanceFigure';
import { colors } from '@/ui/theme/colors';
import { useQbitDisplayLogic, useQbitUnit } from '@qbit/wallet-state';

type Presets = keyof typeof $viewPresets;

/**
 * The width the balance card gives the total's text, unless it says its own
 * (`room`): the viewport less the page's padding (2 × 16 px), the card's
 * (2 × 8 px) and its column's (2 × 8 px), the chevron after the figure
 * (16 px) and its gap (8 px), the unit's margins (2 × 4 px), and 2 px of
 * slack: 98 px.
 */
export const BALANCE_TOTAL_ROOM = 'calc(100vw - 98px)';

/**
 * The width each of the card's Available and Unavailable gets, unless the
 * card says its own: half of the viewport less the page's padding
 * (2 × 16 px), the card's (2 × 8 px), the detail box's (2 × 12 px), the
 * divider (8 px) and the gaps beside it (2 × 8 px), less 2 px of slack.
 */
export const BALANCE_SPLIT_ROOM = 'calc((100vw - 96px) / 2 - 2px)';

const $viewPresets = {
  main: {
    mainPartSize: 28,
    subPartSize: 20,
    unitPartSize: 20,
    mainPartColor: colors.onPrimary,
    subPartColor: colors.onPrimary,
    unitPartColor: colors.onPrimary,
    subPartMarginBottom: 2,
    room: BALANCE_TOTAL_ROOM,
    // The line's height at the full sizes, kept when they shrink.
    rowHeight: 34
  },
  sub: {
    mainPartSize: 12,
    subPartSize: 12,
    unitPartSize: 12,
    mainPartColor: colors.onPrimary,
    subPartColor: colors.onPrimary,
    unitPartColor: colors.onPrimary,
    subPartMarginBottom: 0,
    room: BALANCE_SPLIT_ROOM,
    rowHeight: 14
  }
};

// ProtoMono, the figures' typeface, advances every character 0.64 em.
const ADVANCE_EM = 0.64;

/**
 * The font size of a figure's part of `size` px, where the figure's text at
 * its parts' full sizes is `width` px wide: `size`, or less where `room` is
 * narrower than `width`, every part by the same factor, so that a balance of
 * any length stays on its line without anything around it moving.
 */
export function fittedSize(size: number, width: number, room: string): string {
  return `min(${size}px, calc(${room} * ${(size / Math.max(width, size)).toFixed(6)}))`;
}

export function QbitDisplay({
  balance,
  hideBalance,
  preset,
  room,
  'data-testid': dataTestId
}: {
  balance: string;
  hideBalance?: boolean;
  preset?: Presets;
  /**
   * The width the figure's text has, a CSS length in viewport or absolute
   * units only (`calc(100vw - 120px)`, `240px`): it ends up inside the font
   * size, where a percentage is a share of the parent's font size, not of a
   * width. The preset's default room otherwise.
   */
  room?: string;
  /** The shown figure's test id; the total's is `wallet-balance-figure` unless given. */
  'data-testid'?: string;
}) {
  const qbitUnit = useQbitUnit();
  const $style = preset ? $viewPresets[preset] : $viewPresets['main'];

  // Five decimals, truncated, with the exact amount on hover and for a screen reader.
  const { totalAmountMainPart, totalAmountSubPart, exactAmount } = useQbitDisplayLogic(balance);

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

  const unitComponent = (fontSize: number | string) => (
    <Column justifyCenter mx="sm">
      <Text
        text={qbitUnit}
        preset="title-bold"
        textCenter
        style={{
          fontSize,
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
        {preset !== 'sub' && unitComponent($style.unitPartSize)}
      </Row>
    );
  }

  const showUnit = preset !== 'sub';
  const textWidth =
    ADVANCE_EM *
    (totalAmountMainPart.length * $style.mainPartSize +
      totalAmountSubPart.length * $style.subPartSize +
      (showUnit ? qbitUnit.length * $style.unitPartSize : 0));
  const fit = (size: number) => fittedSize(size, textWidth, room ?? $style.room);

  return (
    <BalanceFigure
      exact={exactAmount && `${exactAmount} ${qbitUnit}`}
      data-testid={dataTestId ?? (preset === 'sub' ? undefined : 'wallet-balance-figure')}
    >
      <Row itemsEnd gap="zero" style={{ minHeight: $style.rowHeight }}>
        <Text
          text={totalAmountMainPart}
          preset="title-bold"
          style={{
            fontSize: fit($style.mainPartSize),
            color: $style.mainPartColor
          }}
        />
        <Text
          text={totalAmountSubPart}
          preset="title-bold"
          style={{
            fontSize: fit($style.subPartSize),
            color: $style.subPartColor,
            marginBottom: $style.subPartMarginBottom
          }}
        />
        {showUnit && unitComponent(fit($style.unitPartSize))}
      </Row>
    </BalanceFigure>
  );
}
