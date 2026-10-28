import { Column, Text } from '@/ui/components';
import type { TextProps } from '@/ui/components/Text';

/** Height of the network icon every picker row is measured against. */
export const NETWORK_OPTION_ROW_HEIGHT = 30;
const LABEL_LINE_HEIGHT = 16;
const SUBTEXT_LINE_HEIGHT = NETWORK_OPTION_ROW_HEIGHT - LABEL_LINE_HEIGHT;

interface Props {
  label: string;
  /** Faint second line, e.g. the regtest loopback endpoint. */
  subtext?: string;
  preset?: TextProps['preset'];
  color?: TextProps['color'];
}

/**
 * Label column for a network picker row. A subtext is folded into the same
 * height the network icon occupies: the two lines get fixed line heights that
 * sum to the icon height, so a two-line row is exactly as tall as a one-line
 * one instead of growing by the subtext's line box.
 */
export function NetworkOptionLabel({ label, subtext, preset, color = 'text' }: Props) {
  if (!subtext) {
    return <Text text={label} preset={preset} color={color} />;
  }
  return (
    <Column gap="zero" justifyCenter style={{ height: NETWORK_OPTION_ROW_HEIGHT }} data-testid="network-option-label">
      <Text text={label} preset={preset} color={color} style={{ lineHeight: `${LABEL_LINE_HEIGHT}px` }} />
      <Text
        text={subtext}
        size="xs"
        color="textFaint"
        style={{ lineHeight: `${SUBTEXT_LINE_HEIGHT}px` }}
        data-testid="network-option-subtext"
      />
    </Column>
  );
}
