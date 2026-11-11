import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ActionMenuItem {
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  'data-testid': string;
  onSelect: () => void;
}

interface ActionMenuProps {
  id: string;
  /** The button that opened the menu; the menu opens next to it. */
  anchor: HTMLElement;
  /** The positioned element the menu is placed in and must fit inside. */
  container: HTMLElement;
  label: string;
  items: ActionMenuItem[];
  /** Closes the menu without choosing an item (Escape, Tab, a tap outside). */
  onDismiss: () => void;
}

const GAP = 4;
const EDGE = 8;

/**
 * A menu of actions for one wallet or account. It opens under its button, or
 * above it when there is no room below, and moves focus to its first item.
 * Arrow keys, Home and End move between items; Escape, Tab and a tap outside
 * close it.
 */
export function ActionMenu({ id, anchor, container, label, items, onDismiss }: ActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = anchorRect.bottom - containerRect.top + GAP;
    const above = anchorRect.top - containerRect.top - height - GAP;
    const fitsBelow = below + height <= containerRect.height - EDGE;
    const top = fitsBelow || above < EDGE ? below : above;
    setPosition({
      top: Math.max(EDGE, Math.min(top, containerRect.height - height - EDGE)),
      right: Math.max(EDGE, containerRect.right - anchorRect.right)
    });
  }, [anchor, container]);

  const placed = position !== null;
  useEffect(() => {
    if (placed) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    }
  }, [placed]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = menuItems.indexOf(document.activeElement as HTMLElement);
    const focusItem = (next: number) => menuItems[(next + menuItems.length) % menuItems.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(menuItems.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        break;
    }
  };

  return (
    <>
      <div className="switcher-menu-backdrop" onClick={onDismiss} aria-hidden="true" />
      <div
        ref={menuRef}
        id={id}
        role="menu"
        aria-label={label}
        className="switcher-menu"
        style={{ top: position?.top ?? 0, right: position?.right ?? EDGE, visibility: placed ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => (
          <button
            key={item['data-testid']}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={item.danger ? 'switcher-menu__item switcher-menu__item--danger' : 'switcher-menu__item'}
            onClick={item.onSelect}
            data-testid={item['data-testid']}
          >
            <span className="switcher-menu__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="switcher-menu__label">{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
