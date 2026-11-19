import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/ui/components/Tooltip';

// Only the ring is stood in for (the components index loads the extension's
// startup screens); the tooltip is the wallet's own.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  return { Spin: () => React.createElement('span', { 'data-testid': 'spin' }) };
});

import { BalanceRefreshControl } from './BalanceRefreshControl';
import { BalanceStatusText } from './BalanceStatusText';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BalanceRefreshControl in the wallet’s own tooltip, not mocked (C)', () => {
  it('shows one tooltip, with the sentence, on hover, and no native title beside it', () => {
    const sentence = 'Reading 2,888 of 3,346 outputs';
    render(
      <Tooltip title={sentence}>
        <BalanceRefreshControl
          busy
          label="Refresh balance"
          description={sentence}
          failing={false}
          color="onPrimary"
          onRefresh={() => undefined}
        />
      </Tooltip>
    );
    const control = screen.getByRole('button', { name: 'Refresh balance' });
    expect(document.querySelector('[title]')).toBeNull();
    expect(screen.queryAllByText(sentence).filter((element) => !control.contains(element))).toEqual([]);

    fireEvent.mouseEnter(control.parentElement as HTMLElement);
    // Once, outside the control: the control itself holds only its description.
    expect(screen.getAllByText(sentence).filter((element) => !control.contains(element))).toHaveLength(1);
    expect(document.querySelector('[title]')).toBeNull();
  });
});

describe('BalanceRefreshControl while nothing can be read (round 3, item 7)', () => {
  it('neither turns nor starts its cooldown on a press, and says it is disabled', () => {
    const onRefresh = vi.fn();
    render(
      <BalanceRefreshControl
        busy={false}
        label="Refresh balance"
        failing={false}
        readable={false}
        color="onPrimary"
        onRefresh={onRefresh}
      />
    );
    const control = screen.getByRole('button', { name: 'Refresh balance' });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(control.dataset.spinning).toBe('false');
  });
});

describe('BalanceStatusText (item 13)', () => {
  it('measures again when the text’s own width changes, as when a font loads after the first measurement', () => {
    const observers: { callback: () => void; observed: Element[] }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observed: Element[] = [];
        constructor(public callback: () => void) {
          observers.push(this);
        }
        observe(element: Element) {
          this.observed.push(element);
        }
        disconnect() {
          this.observed = [];
        }
      }
    );
    let textWidth = 80;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => textWidth);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);

    render(<BalanceStatusText text="Updating…" color="#000" />);
    const line = screen.getByTestId('balance-status-text');
    expect(line.dataset.fits).toBe('true');
    expect(observers.at(-1)?.observed).toContain(line);

    // The font loads: the text widens, its slot does not.
    textWidth = 120;
    act(() => observers.at(-1)?.callback());
    expect(line.dataset.fits).toBe('false');
  });
});
