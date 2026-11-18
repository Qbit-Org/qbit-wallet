import { Spin } from '@/ui/components';
import { colors } from '@/ui/theme/colors';

/**
 * A loader in the place of one of the balance card's numbers: exactly as tall
 * as the line it replaces (`balanceCardLayout`), its spinner at most as tall
 * as that line, so that nothing moves when the number arrives. Only the one
 * that `announce`s says what is loading to assistive technology, so the card
 * says it once however many numbers are loading; the others are hidden from
 * it.
 */
export function BalanceLineLoader({
  height,
  label,
  announce,
  'data-testid': dataTestId
}: {
  height: number;
  label: string;
  announce: boolean;
  'data-testid'?: string;
}) {
  return (
    <div
      {...(announce ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      data-testid={dataTestId}
      data-line-height={height}
      style={{ display: 'flex', alignItems: 'center', height, minHeight: height, maxHeight: height }}
    >
      <Spin size={height >= 20 ? 'default' : 'small'} color={colors.onPrimary} trackColor="rgba(0, 0, 0, 0.12)" />
    </div>
  );
}
