import React, { useEffect, useRef } from 'react';

import { activateOnKey, keepTabInside } from '@/ui/utils/keyboard';

/**
 * Takes focus when the popover opens, keeps Tab inside it and cancels on
 * Escape, so the popover works without a pointer.
 */
export function KeyboardDialog({
  label,
  onEscape,
  children
}: {
  label: string;
  onEscape: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{ outline: 'none' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
          return;
        }
        keepTabInside(event, ref.current);
      }}
    >
      {children}
    </div>
  );
}

/** Keyboard access for the popover's buttons, which render as divs. */
export const keyboardButton = (enabled: boolean, activate: () => void) => ({
  role: 'button',
  tabIndex: enabled ? 0 : -1,
  onKeyDown: activateOnKey(activate)
});
