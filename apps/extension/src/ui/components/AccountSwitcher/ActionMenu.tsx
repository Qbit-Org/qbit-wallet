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
  /**
   * An element at the top of the container that the menu must leave in view,
   * such as a header with a close button: the menu stays below it.
   */
  clearOf?: HTMLElement | null;
  label: string;
  items: ActionMenuItem[];
  /** Closes the menu without choosing an item (Escape, Tab, a tap outside). */
  onDismiss: () => void;
}

const GAP = 4;
const EDGE = 8;

type Box = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>;

export interface MenuPlacement {
  /** From the top of the container. */
  top: number;
  /** From the right edge of the container. */
  right: number;
  /** Set only for a menu taller than the room it has, which then scrolls. */
  maxHeight?: number;
}

/**
 * Where a menu of `size` goes in its container, always below `clearOf`
 * (which stays in view) and inside the container: under its button, aligned
 * with the button's right edge; else above it, aligned the same way. When it
 * fits neither, it goes beside the button, on its left, so as not to hide the
 * button, if the container is wide enough there, and otherwise over it,
 * aligned with its right edge; either way it keeps between `clearOf` and the
 * container's bottom, and a menu taller than that room fills it and scrolls.
 */
export function placeMenu(
  anchor: Box,
  container: Box & Pick<DOMRectReadOnly, 'height'>,
  clearOf: Box | null,
  size: { width: number; height: number }
): MenuPlacement {
  const { width, height } = size;
  const minTop = (clearOf ? clearOf.bottom - container.top : 0) + EDGE;
  const maxBottom = container.height - EDGE;
  const room = maxBottom - minTop;
  const clamp = (top: number) => Math.max(minTop, Math.min(top, maxBottom - height));
  const alignedRight = Math.max(EDGE, container.right - anchor.right);
  const below = anchor.bottom - container.top + GAP;
  const above = anchor.top - container.top - height - GAP;
  if (height <= room) {
    if (below + height <= maxBottom) return { top: clamp(below), right: alignedRight };
    if (above >= minTop) return { top: clamp(above), right: alignedRight };
  }
  const beside = anchor.left - GAP - width >= container.left + EDGE;
  const right = beside ? container.right - anchor.left + GAP : alignedRight;
  if (height > room) {
    return { top: minTop, right, maxHeight: Math.max(room, 0) };
  }
  return { top: clamp(beside ? anchor.top - container.top : below), right };
}

/**
 * A menu of actions for one wallet or account. It opens under its button, or
 * above it when there is no room below, or beside it when there is room for
 * neither (see placeMenu), and moves focus to its first item.
 * Arrow keys, Home and End move between items; Escape, Tab and a tap outside
 * close it.
 */
export function ActionMenu({ id, anchor, container, clearOf, label, items, onDismiss }: ActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // Its whole height, borders included, whatever height it was given.
    const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    setPosition(
      placeMenu(
        anchor.getBoundingClientRect(),
        container.getBoundingClientRect(),
        clearOf?.getBoundingClientRect() ?? null,
        { width: menu.offsetWidth, height }
      )
    );
  }, [anchor, container, clearOf]);

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
        style={{
          top: position?.top ?? 0,
          right: position?.right ?? EDGE,
          maxHeight: position?.maxHeight,
          overflowY: position?.maxHeight === undefined ? undefined : 'auto',
          visibility: placed ? 'visible' : 'hidden'
        }}
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
