import type React from 'react';

/**
 * A keydown handler that runs `activate` on Enter and Space, as a native
 * button does, for an element given `role="button"` (such as `Button`, which
 * renders a div).
 */
export function activateOnKey(activate: () => void) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements in `container` that Tab can reach, in tab order. */
export function tabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.closest('[inert]') && element.getAttribute('aria-hidden') !== 'true'
  );
}

/**
 * Keeps Tab and Shift+Tab inside `container`, wrapping from the last element
 * to the first and back. Call it from the container's keydown handler.
 */
export function keepTabInside(event: React.KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return;
  const elements = tabbableElements(container);
  if (elements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
