import { RotateCw } from 'lucide-react';
import { KeyboardEvent, MouseEvent, useEffect, useId, useState } from 'react';

import { Spin } from '@/ui/components';
import { ColorTypes, colors } from '@/ui/theme/colors';

import { VISUALLY_HIDDEN } from './balanceCardLayout';

// The ring shows this long after a tap, and no other read is asked for this
// soon after it, as the wallet's other refresh control (`RefreshButton`) does.
const TAP_TURN_MS = 1_000;
const TAP_COOLDOWN_MS = 5_000;

/** The control's box: the refresh icon and the ring that takes its place are both this size. */
export const BALANCE_REFRESH_CONTROL_SIZE = 16;

/**
 * The balance card's refresh control, the one way to read again: always
 * there, in the same place and of the same size, and showing the wallet's
 * loading ring (`Spin`) in place of its icon for as long as the card is busy
 * (loading, refreshing, or reading again by itself), so that the card needs
 * no other indicator that moves anything. A failure appearing ends the
 * cooldown of an earlier press, so the first press after it always counts.
 */
export function BalanceRefreshControl({
  busy,
  label,
  description,
  failing,
  readable = true,
  color,
  onRefresh
}: {
  busy: boolean;
  /** The control's accessible name, which stays the same: what it does. */
  label: string;
  /** What the card is doing, as the control's accessible description. */
  description?: string;
  /** The card shows a failure. */
  failing: boolean;
  /**
   * Whether a press can read now: not while the card waits for the account
   * of a new network, when a press neither turns the ring nor starts the cooldown.
   */
  readable?: boolean;
  color: ColorTypes;
  onRefresh: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const [turning, setTurning] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const descriptionId = useId();
  useEffect(() => {
    if (failing) setCoolingDown(false);
  }, [failing]);
  useEffect(() => {
    if (!turning) return undefined;
    const timer = setTimeout(() => setTurning(false), TAP_TURN_MS);
    return () => clearTimeout(timer);
  }, [turning]);
  useEffect(() => {
    if (!coolingDown) return undefined;
    const timer = setTimeout(() => setCoolingDown(false), TAP_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [coolingDown]);

  const refresh = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (coolingDown || !readable) return;
    setCoolingDown(true);
    setTurning(true);
    onRefresh(event);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.click();
  };
  const spinning = busy || turning;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      aria-disabled={coolingDown || !readable}
      data-testid="balance-refresh"
      data-spinning={spinning ? 'true' : 'false'}
      onClick={refresh}
      onKeyDown={onKeyDown}
      style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', margin: '-6px -8px', cursor: 'pointer' }}
    >
      {description ? (
        <span id={descriptionId} style={VISUALLY_HIDDEN}>
          {description}
        </span>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: BALANCE_REFRESH_CONTROL_SIZE,
          height: BALANCE_REFRESH_CONTROL_SIZE
        }}
      >
        {spinning ? (
          <Spin size="small" color={colors[color]} trackColor="rgba(0, 0, 0, 0.12)" />
        ) : (
          <RotateCw size={14} style={{ color: colors[color] }} />
        )}
      </div>
    </div>
  );
}
