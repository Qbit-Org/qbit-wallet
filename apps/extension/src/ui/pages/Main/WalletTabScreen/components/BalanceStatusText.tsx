import { useLayoutEffect, useRef, useState } from 'react';

import { fontSizes } from '@/ui/theme/font';
import { typography } from '@/ui/theme/typography';

/** Whether a line of `textWidth` px shows whole in `available` px: never cut, never wrapped. */
export function textFitsWhole(textWidth: number, available: number): boolean {
  return textWidth <= available;
}

/**
 * The short line beside the balance card's refresh control ("Updating…", or
 * "2,888 / 3,346"): on one line, in whatever room the header row has left
 * once "Wallet Balance" and the control have theirs, and shown only when it
 * fits whole, never cut by an ellipsis and never wrapped; where it does not,
 * the turning control alone says the card is busy. It takes no room of its
 * own, so the row never changes height. Measured from the rendered width
 * whenever the text, its width or the room changes, whatever the language. Assistive
 * technology reads the full sentence from the control instead.
 */
export function BalanceStatusText({ text, color }: { text?: string; color: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const measure = () => {
      const slot = slotRef.current;
      const line = textRef.current;
      if (!slot || !line) return;
      setFits(textFitsWhole(line.scrollWidth, slot.clientWidth));
    };
    measure();
    const slot = slotRef.current;
    if (!slot || typeof ResizeObserver === 'undefined') return undefined;
    // The room changes with the row, and the text's own width with the
    // font, which may load after the first measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    if (textRef.current) observer.observe(textRef.current);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={slotRef}
      data-testid="balance-status-slot"
      style={{ display: 'flex', justifyContent: 'flex-end', flex: 1, minWidth: 0, overflow: 'hidden' }}
    >
      {text ? (
        <span
          ref={textRef}
          aria-hidden
          data-testid="balance-status-text"
          data-fits={fits ? 'true' : 'false'}
          style={{
            whiteSpace: 'nowrap',
            fontSize: fontSizes.xs,
            lineHeight: `${fontSizes.xs + 4}px`,
            fontFamily: typography.primary.regular,
            color,
            visibility: fits ? 'visible' : 'hidden'
          }}
        >
          {text}
        </span>
      ) : null}
    </div>
  );
}
