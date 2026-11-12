import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';

import { ActionMenu, placeMenu } from './ActionMenu';

// A sheet laid out as at popup size: the header row (title and close button)
// at its top, the rows below it, a menu button at the right end of a row.
// Viewport coordinates, as getBoundingClientRect gives them.
const sheet = { top: 100, bottom: 500, left: 0, right: 360, height: 400 };
const header = { top: 100, bottom: 147, left: 0, right: 360 };
const button = (top: number) => ({ top, bottom: top + 32, left: 318, right: 350 });
const MENU = { width: 220, height: 198 };

describe('placeMenu', () => {
  it('opens under its button when there is room, aligned with the button', () => {
    expect(placeMenu(button(200), sheet, header, MENU)).toEqual({ top: 136, right: 10 });
  });

  it('opens above its button when there is no room below, but there is between the header and the button', () => {
    expect(placeMenu(button(440), sheet, header, MENU)).toEqual({ top: 138, right: 10 });
  });

  it('never opens above its button over the header row: in a short sheet it keeps below the header', () => {
    // There is room above the button, but only by reaching into the header.
    const short = { top: 100, bottom: 350, left: 0, right: 360, height: 250 };
    const placement = placeMenu(button(250), short, header, { width: 220, height: 120 });

    expect(placement.top).toBeGreaterThanOrEqual(header.bottom - short.top);
    expect(placement.top + 120).toBeLessThanOrEqual(short.height);
  });

  it('goes beside its button, on its left, when it fits neither under nor above it', () => {
    // Two wallets of one account each at 357 x 600: the second wallet's menu.
    const popup = { top: 204, bottom: 600, left: 0, right: 357, height: 396 };
    const popupHeader = { top: 204, bottom: 261, left: 0, right: 357 };
    const secondWallet = { top: 433, bottom: 465, left: 319, right: 351 };

    const placement = placeMenu(secondWallet, popup, popupHeader, MENU);

    expect(placement).toEqual({ top: 190, right: 42 });
    // The menu's right edge 4 px left of the button: the button stays in view.
    expect(popup.right - placement.right).toBe(secondWallet.left - 4);
    // Still between the header and the sheet's bottom, level with the button.
    expect(popup.top + placement.top).toBeGreaterThanOrEqual(popupHeader.bottom);
    expect(placement.top + MENU.height).toBeLessThanOrEqual(popup.height - 8);
    expect(popup.top + placement.top).toBeLessThanOrEqual(secondWallet.top);
  });

  it('starts level with its button beside it when there is room for that', () => {
    const tall = { top: 100, bottom: 400, left: 0, right: 360, height: 300 };

    expect(placeMenu(button(220), tall, header, { width: 220, height: 160 })).toEqual({ top: 120, right: 46 });
  });

  it('covers its button, as before, when the sheet is too narrow for the menu beside it', () => {
    const narrow = { top: 100, bottom: 350, left: 0, right: 250, height: 250 };
    const atTheEdge = { top: 250, bottom: 282, left: 210, right: 242 };

    expect(placeMenu(atTheEdge, narrow, header, { width: 220, height: 120 })).toEqual({ top: 122, right: 8 });
  });

  it('stays below the header for a button scrolled up under it', () => {
    const placement = placeMenu(button(80), sheet, header, MENU);

    expect(placement.top).toBe(header.bottom - sheet.top + 8);
  });

  it('fills the room below the header and scrolls when taller than that room, beside its button when it can', () => {
    const tiny = { top: 0, bottom: 200, left: 0, right: 360, height: 200 };
    const tinyHeader = { top: 0, bottom: 47, left: 0, right: 360 };

    expect(placeMenu(button(60), tiny, tinyHeader, MENU)).toEqual({ top: 55, right: 46, maxHeight: 137 });
    const narrowTiny = { ...tiny, right: 250 };
    expect(placeMenu({ top: 60, bottom: 92, left: 210, right: 242 }, narrowTiny, tinyHeader, MENU)).toEqual({
      top: 55,
      right: 8,
      maxHeight: 137
    });
  });

  it('without an element to keep clear, keeps to the container, as before', () => {
    expect(placeMenu(button(440), sheet, null, MENU)).toEqual({ top: 138, right: 10 });
    expect(placeMenu(button(110), sheet, null, MENU)).toEqual({ top: 46, right: 10 });
  });

  it('keeps its right edge off the container edge for a button at that edge', () => {
    expect(placeMenu({ top: 200, bottom: 232, left: 328, right: 360 }, sheet, header, MENU).right).toBe(8);
  });
});

describe('ActionMenu', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('places itself from its own size and the boxes of its button, its container and the element it keeps clear of', () => {
    const anchor = document.createElement('button');
    const container = document.createElement('div');
    const headerRow = document.createElement('div');
    document.body.append(container);
    container.append(headerRow, anchor);
    const rect = (box: { top: number; bottom: number; left: number; right: number }) =>
      ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) as DOMRect;
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect({ top: 433, bottom: 465, left: 319, right: 351 }));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect({ top: 204, bottom: 600, left: 0, right: 357 }));
    vi.spyOn(headerRow, 'getBoundingClientRect').mockReturnValue(rect({ top: 204, bottom: 261, left: 0, right: 357 }));
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(MENU.height);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(MENU.width);

    render(
      <ActionMenu
        id="menu"
        anchor={anchor}
        container={container}
        clearOf={headerRow}
        label="Options"
        items={[{ label: 'Rename', icon: null, 'data-testid': 'rename', onSelect: vi.fn() }]}
        onDismiss={vi.fn()}
      />,
      { container }
    );

    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('190px');
    expect(menu.style.right).toBe('42px');
    expect(menu.style.maxHeight).toBe('');
    expect(menu.style.visibility).toBe('visible');
  });
});
