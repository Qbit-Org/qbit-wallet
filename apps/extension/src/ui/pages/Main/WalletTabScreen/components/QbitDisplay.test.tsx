import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';

import { BALANCE_SPLIT_ROOM, BALANCE_TOTAL_ROOM, QbitDisplay, fittedSize } from './QbitDisplay';

// The real layout and text components; the index also loads screens that
// need the browser. jsdom drops a CSS min(), so each text's font size is
// also kept where a test can read it.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const { Text } = await import('@/ui/components/Text');
  return {
    Column: (await import('@/ui/components/Column')).Column,
    Row: (await import('@/ui/components/Row')).Row,
    Text: (props: Parameters<typeof Text>[0]) =>
      React.createElement('span', { 'data-font-size': String(props.style?.fontSize) }, React.createElement(Text, props))
  };
});
vi.mock('@qbit/wallet-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qbit/wallet-state')>()),
  useQbitUnit: () => 'QBT'
}));

/** The visible figure: the parts a screen reader skips, joined. */
function shownText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[aria-hidden="true"]'))
    .map((element) => element.textContent)
    .join('');
}

describe('QbitDisplay', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the whole coins with commas and five decimals, truncated, then the unit', () => {
    const { container } = render(<QbitDisplay balance="118591.83137906" />);

    expect(screen.getByText('118,591.')).toBeTruthy();
    expect(screen.getByText('83137')).toBeTruthy();
    expect(screen.getByText('QBT')).toBeTruthy();
    expect(shownText(container)).toBe('118,591.83137QBT');
  });

  it('never rounds up, and never shows a balance above zero as zero', () => {
    const { container, rerender } = render(<QbitDisplay balance="20999999.99999999" />);
    expect(shownText(container)).toBe('20,999,999.99999QBT');

    rerender(<QbitDisplay balance="0.00001999" />);
    expect(shownText(container)).toBe('0.00001QBT');

    rerender(<QbitDisplay balance="0.00000001" />);
    expect(shownText(container)).toBe('<0.00001QBT');

    rerender(<QbitDisplay balance="0.00000000" />);
    expect(shownText(container)).toBe('0.00000QBT');
  });

  it('gives the exact amount with its unit on hover and to a screen reader', () => {
    const { container } = render(<QbitDisplay balance="118591.83137906" />);

    const figure = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(figure.getAttribute('title')).toBe('118,591.83137906 QBT');
    // Read in the figure's place: the only text outside the hidden figure.
    const spoken = screen.getByText('118,591.83137906 QBT');
    expect(spoken.closest('[aria-hidden]')).toBeNull();
    expect(spoken.style.position).toBe('absolute');
    expect(spoken.style.clipPath).toBe('inset(50%)');
  });

  it('gives the unit with the exact amount where the figure shows none', () => {
    const { container } = render(<QbitDisplay preset="sub" balance="1234.56789012" />);

    expect(shownText(container)).toBe('1,234.56789');
    expect(screen.queryByText('QBT')).toBeNull();
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe('1,234.56789012 QBT');
    expect(screen.getByText('1,234.56789012 QBT')).toBeTruthy();
  });

  it('shows **** and reveals nothing while the balance is hidden', () => {
    for (const preset of [undefined, 'sub'] as const) {
      const { container, unmount } = render(<QbitDisplay preset={preset} balance="118591.83137906" hideBalance />);

      expect(screen.getByText('****')).toBeTruthy();
      expect(container.textContent).not.toMatch(/\d/);
      expect(container.querySelector('[title]')).toBeNull();
      unmount();
    }
  });

  const fontSizes = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-font-size]')).map((element) => element.getAttribute('data-font-size'));

  it('fits every part of the figure to the room the card gives it, by the width of its characters', () => {
    // 21,000,000.12345 QBT: 11 characters at 28 px, 5 and 3 at 20 px, 0.64 em each.
    const { container, rerender } = render(<QbitDisplay balance="21000000.12345678" />);
    const total = 0.64 * (11 * 28 + 5 * 20 + 3 * 20);
    expect(fontSizes(container)).toEqual([
      fittedSize(28, total, BALANCE_TOTAL_ROOM),
      fittedSize(20, total, BALANCE_TOTAL_ROOM),
      fittedSize(20, total, BALANCE_TOTAL_ROOM)
    ]);

    // Available and Unavailable: no unit, half the room.
    rerender(<QbitDisplay preset="sub" balance="21000000.12345678" />);
    const split = 0.64 * (11 * 12 + 5 * 12);
    expect(fontSizes(container)).toEqual([
      fittedSize(12, split, BALANCE_SPLIT_ROOM),
      fittedSize(12, split, BALANCE_SPLIT_ROOM)
    ]);

    // The line keeps its height when the sizes shrink, so nothing around it moves.
    const lineHeight = (c: HTMLElement) => (c.querySelector('[title] > div') as HTMLElement).style.minHeight;
    expect(lineHeight(container)).toBe('14px');
    rerender(<QbitDisplay balance="21000000.12345678" />);
    expect(lineHeight(container)).toBe('34px');

    // Hidden, the preset's sizes.
    rerender(<QbitDisplay balance="21000000.12345678" hideBalance />);
    expect(fontSizes(container)).toEqual(['28', '20']);
  });

  it('keeps 2 px of slack in its default rooms, beside what the card takes', () => {
    // The total: page 2 × 16, card 2 × 8, its column 2 × 8, chevron 16 and
    // gap 8, unit margins 2 × 4 (96 px), and 2 px more.
    expect(BALANCE_TOTAL_ROOM).toBe('calc(100vw - 98px)');
    // Each column: page 2 × 16, card 2 × 8, detail box 2 × 12, divider 8,
    // gaps 2 × 8 (96 px), halved, and 2 px less.
    expect(BALANCE_SPLIT_ROOM).toBe('calc((100vw - 96px) / 2 - 2px)');
  });

  it('fits into the room the card says, when it says one', () => {
    const { container, rerender } = render(<QbitDisplay balance="21000000.12345678" room="calc(100vw - 140px)" />);
    const total = 0.64 * (11 * 28 + 5 * 20 + 3 * 20);
    expect(fontSizes(container)).toEqual([28, 20, 20].map((size) => fittedSize(size, total, 'calc(100vw - 140px)')));

    rerender(<QbitDisplay preset="sub" balance="21000000.12345678" room="120px" />);
    const split = 0.64 * (11 * 12 + 5 * 12);
    expect(fontSizes(container)).toEqual([12, 12].map((size) => fittedSize(size, split, '120px')));
  });

  it('names the total’s shown figure for tests, only while it shows an amount', () => {
    const { rerender } = render(<QbitDisplay balance="118591.83137906" />);
    const figure = screen.getByTestId('wallet-balance-figure');
    expect(figure.getAttribute('title')).toBe('118,591.83137906 QBT');
    expect(figure.getAttribute('aria-hidden')).toBe('true');

    rerender(<QbitDisplay balance="118591.83137906" hideBalance />);
    expect(screen.queryByTestId('wallet-balance-figure')).toBeNull();
    rerender(<QbitDisplay balance="--" />);
    expect(screen.queryByTestId('wallet-balance-figure')).toBeNull();

    // Available and Unavailable carry one only when the card gives one.
    rerender(<QbitDisplay preset="sub" balance="118591.83137906" />);
    expect(screen.queryByTestId('wallet-balance-figure')).toBeNull();
    rerender(<QbitDisplay preset="sub" balance="118591.83137906" data-testid="available-figure" />);
    expect(screen.getByTestId('available-figure').getAttribute('title')).toBe('118,591.83137906 QBT');
  });

  it('shows an unknown balance as --, with no exact amount', () => {
    const { container } = render(<QbitDisplay preset="sub" balance="--" />);

    expect(container.textContent).toBe('--');
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });
});

describe('fittedSize', () => {
  it('is the full size, or the room times size / width where that is less', () => {
    // 21,000,000.12345 QBT: 11 characters at 28 px, 5 and 3 at 20 px.
    const width = 0.64 * (11 * 28 + 5 * 20 + 3 * 20);
    expect(fittedSize(28, width, 'calc(100vw - 96px)')).toBe('min(28px, calc(calc(100vw - 96px) * 0.093483))');
    expect(fittedSize(20, width, 'calc(100vw - 96px)')).toBe('min(20px, calc(calc(100vw - 96px) * 0.066774))');
  });

  it('never divides by a width narrower than the size itself', () => {
    expect(fittedSize(12, 0, 'calc((100vw - 96px) / 2)')).toBe('min(12px, calc(calc((100vw - 96px) / 2) * 1.000000))');
  });
});
