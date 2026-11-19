import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { colors } from '@/ui/theme/colors';
import { QBIT_BALANCE_READ_PROGRESS } from '@qbit/wallet-shared';
import { useBalanceCardLogic } from '@qbit/wallet-state';
import type { BalanceCardShown, BalanceCardStatus } from '@qbit/wallet-state';
import { Provider } from 'react-redux';

import en from '../../../../../_locales/en/messages.json';
import es from '../../../../../_locales/es/messages.json';
import fr from '../../../../../_locales/fr/messages.json';
import ja from '../../../../../_locales/ja/messages.json';
import ru from '../../../../../_locales/ru/messages.json';
import zhTW from '../../../../../_locales/zh_TW/messages.json';
import { BalanceCard } from './BalanceCard';
import {
  BALANCE_SPLIT_DIMMED_OPACITY,
  BALANCE_SPLIT_LINE_HEIGHT,
  BALANCE_TOTAL_DIMMED_OPACITY,
  BALANCE_TOTAL_LINE_HEIGHT
} from './balanceCardLayout';
import { BALANCE_REFRESH_CONTROL_SIZE } from './BalanceRefreshControl';
import { textFitsWhole } from './BalanceStatusText';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const { createPortal } = await import('react-dom');
  const Container = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: MouseEventHandler;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon, color }: { icon?: string; color?: string }) =>
    React.createElement('span', { 'data-icon': icon, 'data-color': color });
  // Keyed by a string title, or "rich" for element content, so each tooltip can be found.
  const Tooltip = ({ children, title }: { children?: ReactNode; title?: ReactNode }) => {
    const key = typeof title === 'string' ? title : 'rich';
    return React.createElement(
      'div',
      { 'data-testid': `tooltip:${key}` },
      children,
      // Portalled out, as the real overlay is, so the card's text stays the card's.
      createPortal(React.createElement('div', { 'data-testid': `tooltip-title:${key}` }, title), document.body)
    );
  };
  const Spin = ({ size }: { size?: string }) =>
    React.createElement('span', { 'data-testid': 'spin', 'data-size': size });
  return { Column: Container, Icon, Row: Container, Spin, Text, Tooltip };
});
vi.mock('./QbitDisplay', async () => {
  const React = await import('react');
  return {
    // A hidden balance shows no amount, as the real one shows `****`.
    QbitDisplay: ({ balance, preset, hideBalance }: { balance: string; preset?: string; hideBalance?: boolean }) =>
      React.createElement(
        'span',
        { 'data-testid': preset === 'sub' ? 'balance-split-amount' : 'balance-amount' },
        hideBalance ? '****' : balance
      )
  };
});
// The card's logic is given by each test; the rest of the package is real, for
// the tests that put the real logic, store and reducer behind the card.
vi.mock('@qbit/wallet-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qbit/wallet-state')>()),
  useBalanceCardLogic: vi.fn()
}));

const known: BalanceCardShown = {
  total: 5_000,
  split: { kind: 'known', available: 5_000, unavailable: 0 },
  limitExceeded: false,
  source: 'own'
};
const totalOnly: BalanceCardShown = {
  total: 91_000_000,
  split: { kind: 'loading' },
  limitExceeded: false,
  source: 'early'
};
const overLimitShown: BalanceCardShown = {
  total: 91_000_000,
  split: { kind: 'limit' },
  limitExceeded: true,
  source: 'own'
};

const loading: BalanceCardStatus = { kind: 'loading', hidden: false, busy: true };
const totalKnown: BalanceCardStatus = { kind: 'total', shown: totalOnly, hidden: false, busy: true };
const ready: BalanceCardStatus = { kind: 'ready', shown: known, hidden: false, busy: false };
const refreshing: BalanceCardStatus = { kind: 'refreshing', shown: known, reason: 'poll', hidden: false, busy: true };
const failedOverShown: BalanceCardStatus = {
  kind: 'failed',
  shown: known,
  totalCurrent: false,
  hidden: false,
  busy: false
};
// The outputs could not be read; the total is the newest read's own.
const failedOverTotal: BalanceCardStatus = {
  kind: 'failed',
  shown: totalOnly,
  totalCurrent: true,
  hidden: false,
  busy: false
};
const failedEmpty: BalanceCardStatus = { kind: 'failed-empty', hidden: false, busy: false };

// The amount strings the logic gives for each value (QbitDisplay formats them).
const amountsOf = (status: BalanceCardStatus) => {
  if (status.kind === 'loading' || status.kind === 'failed-empty') {
    return { balanceValue: '--', availableAmount: '--', unavailableAmount: '--' };
  }
  const { shown } = status;
  const amount = (sats: number) => (sats / 1e8).toFixed(8);
  return {
    balanceValue: amount(shown.total),
    availableAmount: shown.split.kind === 'known' ? amount(shown.split.available) : '--',
    unavailableAmount: shown.split.kind === 'known' ? amount(shown.split.unavailable) : '--'
  };
};

function renderCard(state: Partial<ReturnType<typeof useBalanceCardLogic>> & { status?: BalanceCardStatus }) {
  const status = state.status ?? ready;
  const shown = status.kind === 'loading' || status.kind === 'failed-empty' ? undefined : status.shown;
  // As the logic derives them from the status.
  const outputsUnread = status.kind === 'failed' && status.shown.split.kind === 'loading';
  const logic = {
    status,
    statusText: undefined,
    statusShortText: state.statusShortText ?? state.statusText,
    liveText: undefined,
    balanceErrorText: undefined,
    ...amountsOf(status),
    unavailableTipText: 'unavailable_tooltip',
    t: (key: string) => key,
    utxoLimitExceeded: shown?.limitExceeded === true,
    utxoLimitExceededText: 'utxo_limit_exceeded_balance',
    balanceSplitUnknown: shown?.split.kind === 'limit',
    balanceSplitUnknownText: 'utxo_limit_exceeded_balance_detail',
    isDetailExpanded: false,
    handleExpandToggle: vi.fn(),
    isBalanceHidden: status.hidden,
    handleHiddenToggle: vi.fn(),
    refreshBalance: vi.fn(),
    outputsUnread,
    outputsUnreadText: outputsUnread ? 'balance_outputs_incomplete' : undefined,
    outputsUnreadDetailText: outputsUnread ? 'balance_outputs_incomplete_detail' : undefined,
    totalDimmed: status.kind === 'refreshing' || (status.kind === 'failed' && !(outputsUnread && status.totalCurrent)),
    splitDimmed: status.kind === 'refreshing' || (status.kind === 'failed' && !outputsUnread),
    ...state
  };
  vi.mocked(useBalanceCardLogic).mockReturnValue(logic as unknown as ReturnType<typeof useBalanceCardLogic>);
  lastView = render(<BalanceCard />);
  return logic;
}
// The card renderCard rendered last, to render it again with other logic.
let lastView: ReturnType<typeof render> | undefined;

const card = () => screen.getByTestId('wallet-balance-card');
const opacityOf = (testId: string) => screen.getByTestId(testId).style.opacity;
const splitTexts = () => screen.queryAllByTestId('balance-split-amount').map((element) => element.textContent);
// Every loader, announced or not.
const loaderHeights = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-line-height]')).map((element) => [
    element.dataset.testid,
    parseFloat(element.style.height)
  ]);

describe('BalanceCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the split as unknown, with a line saying why, past the explorer UTXO limit (#341)', () => {
    renderCard({ status: { ...ready, shown: overLimitShown }, isDetailExpanded: true });

    expect(card().textContent).toContain('0.91000000');
    expect(card().textContent).toContain('available--');
    expect(card().textContent).toContain('unavailable--');
    expect(card().textContent).not.toContain('0.00000000');
    expect(screen.getByTestId('balance-utxo-limit-note').textContent).toBe('utxo_limit_exceeded_balance');
    expect(screen.getByTestId('balance-split-unknown-note').textContent).toBe('utxo_limit_exceeded_balance_detail');
    // The tooltip explaining a measured Unavailable is not offered for an unknown one.
    expect(screen.queryByTestId('tooltip:rich')).toBeNull();
    // A lasting cause, stated: no loader stands in for the split.
    expect(screen.queryAllByRole('status')).toEqual([]);
  });

  it('shows the split line only in the expanded rows', () => {
    renderCard({ status: { ...ready, shown: overLimitShown }, isDetailExpanded: false });

    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('labels the balance visibility toggle and the refresh control', () => {
    renderCard({ isBalanceHidden: false });
    expect(screen.getByTestId('tooltip:hide_balance').contains(screen.getByTestId('balance-visibility-toggle'))).toBe(
      true
    );
    expect(screen.getByTestId('tooltip:refresh_balance').contains(screen.getByTestId('balance-refresh'))).toBe(true);
    expect(screen.getByRole('button', { name: 'refresh_balance' })).toBe(screen.getByTestId('balance-refresh'));
    cleanup();

    renderCard({ isBalanceHidden: true });
    expect(screen.getByTestId('tooltip:show_balance')).toBeTruthy();
    expect(screen.queryByTestId('tooltip:hide_balance')).toBeNull();
  });

  it('refreshes from the refresh control without toggling the card, and asks for no other read for 5 s', () => {
    vi.useFakeTimers();
    try {
      const logic = renderCard({});
      fireEvent.click(screen.getByTestId('balance-refresh'));
      fireEvent.click(screen.getByTestId('balance-refresh'));
      expect(logic.refreshBalance).toHaveBeenCalledTimes(1);
      expect(logic.handleExpandToggle).not.toHaveBeenCalled();
      // The ring stands in for the icon a moment after the tap, as the other refresh control turns.
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('false');
      fireEvent.keyDown(screen.getByTestId('balance-refresh'), { key: 'Enter' });
      expect(logic.refreshBalance).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows measured amounts and no unknown line for an ordinary balance', () => {
    renderCard({ isDetailExpanded: true, unavailableTipText: 'Locked due to:\n• Protected assets\n• Unconfirmed' });

    expect(card().textContent).toContain('available0.00005000');
    expect(card().textContent).toContain('unavailable0.00000000');
    const tip = screen.getByTestId('tooltip-title:rich');
    expect(tip.firstElementChild?.firstElementChild?.textContent).toBe('Locked due to:');
    expect(Array.from(tip.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'Protected assets',
      'Unconfirmed'
    ]);
    // The trigger uses the shared lucide glyph, not a one-off SVG.
    expect(screen.getByTestId('tooltip:rich').querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(
      'circle-question'
    );
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
    // Ready: nothing dimmed, nothing loading, nothing said.
    expect(opacityOf('balance-total-line')).toBe('1');
    expect(screen.queryByTestId('balance-status-text')).toBeNull();
    expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('false');
    expect(card().getAttribute('aria-busy')).toBe('false');
  });

  // The quiet box (O2): the surface's own colours, no border, no fill of
  // its own, the icon in the text's colour; said once as an alert.
  const expectQuietBox = (text: string) => {
    const box = screen.getByTestId('balance-error');
    expect(screen.getByRole('alert')).toBe(box);
    expect(box.style.backgroundColor).toBe(colors.surface);
    expect(box.style.color).toBe(colors.text);
    expect(box.style.border).toBe('');
    expect(box.style.backgroundImage).toBe('');
    expect(box.querySelector('[data-icon="alert"]')?.getAttribute('data-color')).toBe('text');
    expect(screen.getByTestId('balance-error-note').textContent).toBe(text);
    // No button: the refresh control reads again (O1).
    expect(screen.queryByRole('button', { name: 'try_again' })).toBeNull();
    expect(box.querySelector('button')).toBeNull();
  };

  it('shows the load error in the quiet box instead of a zero balance when nothing could be loaded, the refresh control to read again', () => {
    const logic = renderCard({
      status: failedEmpty,
      balanceErrorText: 'balance_load_error',
      isDetailExpanded: true
    });

    expect(screen.queryByTestId('balance-amount')).toBeNull();
    expect(screen.queryByTestId('balance-total-line')).toBeNull();
    // Nothing loaded, so there is no breakdown either.
    expect(screen.queryByTestId('balance-split-amount')).toBeNull();
    expect(screen.queryAllByRole('status')).toEqual([]);
    expectQuietBox('balance_load_error');
    expect(card().style.backgroundColor).toBe(colors.neutralFill);

    fireEvent.click(screen.getByTestId('balance-error'));
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('balance-refresh'));
    expect(logic.refreshBalance).toHaveBeenCalledTimes(1);
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
  });

  it('shows one refresh error in the quiet box over the last balance, dimmed, and nothing else', () => {
    renderCard({ status: failedOverShown, balanceErrorText: 'balance_refresh_error', isDetailExpanded: true });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
    expect(splitTexts()).toEqual(['0.00005000', '0.00000000']);
    expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
    expect(opacityOf('balance-available-line')).toBe(String(BALANCE_SPLIT_DIMMED_OPACITY));
    expectQuietBox('balance_refresh_error');
    expect(card().style.backgroundColor).toBe(colors.accent);
    expect(screen.queryByTestId('balance-outputs-note')).toBeNull();
    // One message: no status line, no loader, no other note.
    expect(screen.queryByTestId('balance-status-text')).toBeNull();
    expect(screen.queryAllByRole('status')).toEqual([]);
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('keeps an over-limit balance, its unknown split and its note next to the refresh error', () => {
    renderCard({
      status: { ...failedOverShown, shown: overLimitShown },
      isDetailExpanded: true,
      balanceErrorText: 'balance_refresh_error'
    });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.getByTestId('balance-split-unknown-note')).toBeTruthy();
    expect(card().textContent).toContain('available--');
  });

  it('says whether the breakdown is open on the card itself, a card with nothing to break down included (round 3, item 9)', () => {
    renderCard({ status: failedEmpty, balanceErrorText: 'balance_load_error', isDetailExpanded: true });
    expect(card().dataset.detailOpen).toBe('true');
    expect(screen.queryByTestId('balance-available-line')).toBeNull();
    cleanup();
    renderCard({ status: ready, isDetailExpanded: false });
    expect(card().dataset.detailOpen).toBe('false');
  });

  it('reads nothing on a press while the account is still the previous network’s (round 3, item 7)', () => {
    const logic = renderCard({ status: loading, canRefresh: false });
    fireEvent.click(screen.getByTestId('balance-refresh'));
    expect(logic.refreshBalance).not.toHaveBeenCalled();
    expect(screen.getByTestId('balance-refresh').getAttribute('aria-disabled')).toBe('true');
  });

  it('lets the first press of the refresh control after a failure appears count, whatever its cooldown (O1)', () => {
    vi.useFakeTimers();
    try {
      const logic = renderCard({ status: ready });
      fireEvent.click(screen.getByTestId('balance-refresh'));
      expect(logic.refreshBalance).toHaveBeenCalledTimes(1);
      // Cooling down: a second press within 5 s asks for nothing.
      fireEvent.click(screen.getByTestId('balance-refresh'));
      expect(logic.refreshBalance).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('balance-refresh').getAttribute('aria-disabled')).toBe('true');

      // A failure appears 1 s later, the control still mounted: the next press counts.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const control = screen.getByTestId('balance-refresh');
      vi.mocked(useBalanceCardLogic).mockReturnValue({
        ...logic,
        status: failedOverShown,
        balanceErrorText: 'balance_refresh_error',
        totalDimmed: true,
        splitDimmed: true
      } as unknown as ReturnType<typeof useBalanceCardLogic>);
      lastView!.rerender(<BalanceCard />);
      expect(screen.getByTestId('balance-refresh')).toBe(control);
      expect(control.getAttribute('aria-disabled')).toBe('false');
      fireEvent.click(control);
      expect(logic.refreshBalance).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    'shows loaders as tall as each line in place of every number on first load, the detail open: %s',
    (expanded) => {
      renderCard({ status: loading, isDetailExpanded: expanded });

      expect(screen.getAllByRole('status', { name: 'balance_loading' })[0]?.dataset.testid).toBe('balance-loading');
      expect(loaderHeights()).toEqual([
        ['balance-loading', BALANCE_TOTAL_LINE_HEIGHT],
        ...(expanded
          ? [
              ['balance-available-loading', BALANCE_SPLIT_LINE_HEIGHT],
              ['balance-unavailable-loading', BALANCE_SPLIT_LINE_HEIGHT]
            ]
          : [])
      ]);
      expect(screen.queryByTestId('balance-amount')).toBeNull();
      expect(screen.queryByTestId('balance-split-amount')).toBeNull();
      // No message, no error, on the brand fill, and busy.
      expect(screen.queryByTestId('balance-error')).toBeNull();
      expect(screen.queryByTestId('balance-status-text')).toBeNull();
      expect(card().style.backgroundColor).toBe(colors.accent);
      expect(card().getAttribute('aria-busy')).toBe('true');
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
      // The chevron keeps its place.
      expect(document.querySelector('[data-icon="down"], [data-icon="up"]')).not.toBeNull();
    }
  );

  it('shows the total and loaders in place of Available and Unavailable once the total is known, with no `--` and no sentence', () => {
    renderCard({ status: totalKnown, isDetailExpanded: true });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(opacityOf('balance-total-line')).toBe('1');
    expect(loaderHeights()).toEqual([
      ['balance-available-loading', BALANCE_SPLIT_LINE_HEIGHT],
      ['balance-unavailable-loading', BALANCE_SPLIT_LINE_HEIGHT]
    ]);
    expect(card().textContent).not.toContain('--');
    expect(screen.queryByTestId('balance-split-amount')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
    // Nor the tooltip about a measured Unavailable.
    expect(screen.queryByTestId('tooltip:rich')).toBeNull();
  });

  it.each(['cached', 'user', 'retry', 'poll'] as const)(
    'dims the shown balance and says it is updating while it is refreshed (%s), with no message',
    (reason) => {
      renderCard({ status: { ...refreshing, reason }, statusText: 'balance_updating', isDetailExpanded: true });

      expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
      expect(splitTexts()).toEqual(['0.00005000', '0.00000000']);
      expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
      expect(opacityOf('balance-available-line')).toBe(String(BALANCE_SPLIT_DIMMED_OPACITY));
      expect(opacityOf('balance-unavailable-line')).toBe(String(BALANCE_SPLIT_DIMMED_OPACITY));
      expect(screen.getByTestId('balance-status-text').textContent).toBe('balance_updating');
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
      expect(card().getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByTestId('balance-error')).toBeNull();
      expect(screen.queryByTestId('balance-outputs-note')).toBeNull();
    }
  );

  it('shows how far a long read has got in short beside the control, and the full sentence as its description and tooltip, its name staying the same (A, item 12, C, D)', () => {
    renderCard({
      status: { ...totalKnown, progress: { read: 2_888, total: 3_346 } },
      statusText: 'Reading 2,888 of 3,346 outputs',
      statusShortText: '2,888 / 3,346'
    });

    const line = screen.getByTestId('balance-status-text');
    expect(line.textContent).toBe('2,888 / 3,346');
    // On one line, never cut: no ellipsis, and hidden whole where it does not fit.
    expect(line.style.whiteSpace).toBe('nowrap');
    expect(line.style.textOverflow).toBe('');
    // Beside the refresh control, in the header row that is already there.
    expect(screen.getByTestId('balance-status-slot').contains(line)).toBe(true);
    const control = screen.getByTestId('balance-refresh');
    // The name is what the control does, in every state; the sentence is its
    // description, so a count that moves is not read out as a new name.
    expect(screen.getByRole('button', { name: 'refresh_balance' })).toBe(control);
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Reading 2,888 of 3,346 outputs');
    // One tooltip, the wallet's: no native title beside it.
    expect(control.getAttribute('title')).toBeNull();
    expect(card().querySelector('[title]')).toBeNull();
    expect(screen.getByTestId('tooltip:Reading 2,888 of 3,346 outputs').contains(control)).toBe(true);
  });

  it('keeps "Wallet Balance" on one line, never shrunk (A)', () => {
    renderCard({ status: refreshing, statusText: 'balance_updating' });
    const label = screen.getByTestId('balance-label');
    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.flexShrink).toBe('0');
  });

  it('shows the short line only where it fits whole, and the ring alone where it does not (A)', () => {
    const widths = (text: number, room: number) => {
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(text);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(room);
    };
    try {
      widths(80, 79);
      renderCard({ status: refreshing, statusText: 'balance_updating' });
      expect(screen.getByTestId('balance-status-text').dataset.fits).toBe('false');
      expect(screen.getByTestId('balance-status-text').style.visibility).toBe('hidden');
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
      cleanup();

      widths(80, 80);
      renderCard({ status: refreshing, statusText: 'balance_updating' });
      expect(screen.getByTestId('balance-status-text').dataset.fits).toBe('true');
      expect(screen.getByTestId('balance-status-text').style.visibility).toBe('visible');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('decides the fit by width alone (A)', () => {
    expect(textFitsWhole(153, 153)).toBe(true);
    expect(textFitsWhole(180, 153)).toBe(false);
  });

  it('dims each figure as far as its size and background allow: the total to 3:1, the split to 4.5:1 (item 6)', () => {
    // The card's text in both themes (styles/global.less), #101412, on the
    // brand green #1ab453; Available and Unavailable on the detail box,
    // rgba(0, 0, 0, 0.08) over the green, #18a64c once composited (8-bit).
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const text = [0x10, 0x14, 0x12];
    const green = [0x1a, 0xb4, 0x53];
    const box = green.map((value) => Math.round(value * 0.92));
    expect(box).toEqual([0x18, 0xa6, 0x4c]);
    const contrast = (fill: number[], opacity: number, round = false) => {
      const shown = text.map((value, index) => {
        const mixed = opacity * value + (1 - opacity) * fill[index];
        return round ? Math.round(mixed) : mixed;
      });
      return (luminance(fill) + 0.05) / (luminance(shown) + 0.05);
    };
    expect(contrast(green, 1)).toBeCloseTo(6.81, 2);
    // The 28 px total: 3.30:1, enough for text of 24 px and more, and plainly dimmer.
    expect(contrast(green, BALANCE_TOTAL_DIMMED_OPACITY)).toBeCloseTo(3.3, 2);
    expect(contrast(green, BALANCE_TOTAL_DIMMED_OPACITY)).toBeGreaterThanOrEqual(3);
    // The 12 px split: 4.59:1 (4.61:1 with the dimmed text rounded to 8 bits),
    // at the least opacity that reaches 4.5:1 both ways; 0.81 does not once rounded.
    expect(contrast(box, 1)).toBeCloseTo(5.83, 2);
    expect(contrast(box, BALANCE_SPLIT_DIMMED_OPACITY)).toBeCloseTo(4.59, 2);
    expect(contrast(box, BALANCE_SPLIT_DIMMED_OPACITY, true)).toBeCloseTo(4.61, 2);
    expect(contrast(box, BALANCE_SPLIT_DIMMED_OPACITY - 0.01, true)).toBeLessThan(4.5);
  });

  it('shows the total, a note on the card, `--` for the split and a note under it, and no box, when the outputs could not be read (O4)', () => {
    renderCard({ status: failedOverTotal, isDetailExpanded: true });
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    // Its own statistics answered: the total is not out of date.
    expect(opacityOf('balance-total-line')).toBe('1');
    expect(screen.getByTestId('balance-outputs-note').textContent).toBe('balance_outputs_incomplete');
    expect(screen.getByRole('alert').textContent).toBe('balance_outputs_incomplete');
    expect(splitTexts()).toEqual(['--', '--']);
    expect(screen.getByTestId('balance-outputs-detail-note').textContent).toBe('balance_outputs_incomplete_detail');
    expect(screen.queryByTestId('balance-error')).toBeNull();
    // Nothing spins under it, and the lines keep their heights.
    expect(loaderHeights()).toEqual([]);
    expect(screen.queryAllByTestId('spin')).toEqual([]);
    for (const name of ['available', 'unavailable']) {
      expect(screen.getByTestId(`balance-${name}-line`).style.height).toBe(`${BALANCE_SPLIT_LINE_HEIGHT}px`);
    }
    cleanup();

    // A total from an older read (the newest read's statistics failed): dimmed.
    renderCard({ status: { ...failedOverTotal, totalCurrent: false }, isDetailExpanded: false });
    expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
    expect(screen.getByTestId('balance-outputs-note')).toBeTruthy();
    // The note under the split shows with the breakdown only.
    expect(screen.queryByTestId('balance-outputs-detail-note')).toBeNull();
  });

  it('shows **** in place of every loader while the balance is hidden, the control still busy (item 11)', () => {
    renderCard({ status: { ...loading, hidden: true }, isDetailExpanded: true });
    expect(loaderHeights()).toEqual([]);
    expect(screen.getByTestId('balance-amount').textContent).toBe('****');
    expect(splitTexts()).toEqual(['****', '****']);
    expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
    expect(card().getAttribute('aria-busy')).toBe('true');
  });

  it('announces loading once, however many numbers are loading (item 12)', () => {
    renderCard({ status: loading, isDetailExpanded: true });
    expect(screen.getAllByRole('status').map((element) => element.dataset.testid)).toEqual(['balance-loading']);
    expect(loaderHeights()).toHaveLength(3);
    cleanup();
    renderCard({ status: totalKnown, isDetailExpanded: true });
    expect(screen.getAllByRole('status').map((element) => element.dataset.testid)).toEqual([
      'balance-available-loading'
    ]);
  });

  it('tells a screen reader politely that the card is updating, in one live region (item 12)', () => {
    renderCard({ status: refreshing, statusText: 'balance_updating', liveText: 'balance_updating' });
    const live = screen.getByTestId('balance-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('balance_updating');
    // The visible short line is not read on its own.
    expect(screen.getByTestId('balance-status-text').getAttribute('aria-hidden')).toBe('true');
  });

  it('says the refresh control is disabled during its cooldown (item 12)', () => {
    vi.useFakeTimers();
    try {
      renderCard({});
      const control = screen.getByTestId('balance-refresh');
      expect(control.getAttribute('aria-disabled')).toBe('false');
      fireEvent.click(control);
      expect(control.getAttribute('aria-disabled')).toBe('true');
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(control.getAttribute('aria-disabled')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every line at its height and the same rows in place across first load, total known, ready and refreshing', () => {
    for (const expanded of [false, true]) {
      const layouts = [loading, totalKnown, ready, refreshing].map((status) => {
        renderCard({ status, isDetailExpanded: expanded });
        const lines = Array.from(card().querySelectorAll<HTMLElement>('[data-testid$="-line"]')).map((line) => [
          line.dataset.testid,
          line.style.height
        ]);
        const layout = {
          lines,
          // What takes room in the card, in order: the same elements in every state.
          rows: Array.from(card().querySelectorAll<HTMLElement>('[data-testid]'))
            .map((element) => element.dataset.testid)
            .filter((testId) =>
              /^(balance-(total-line|available-line|unavailable-line|error|utxo-limit-note|split-unknown-note))$/.test(
                testId ?? ''
              )
            )
        };
        cleanup();
        return layout;
      });
      const expected = {
        lines: [
          ['balance-total-line', `${BALANCE_TOTAL_LINE_HEIGHT}px`],
          ...(expanded
            ? [
                ['balance-available-line', `${BALANCE_SPLIT_LINE_HEIGHT}px`],
                ['balance-unavailable-line', `${BALANCE_SPLIT_LINE_HEIGHT}px`]
              ]
            : [])
        ],
        rows: ['balance-total-line', ...(expanded ? ['balance-available-line', 'balance-unavailable-line'] : [])]
      };
      for (const layout of layouts) expect(layout).toEqual(expected);
    }
  });

  it('marks the total, Available, Unavailable and the refresh control with stable test ids, on the value or the loader in its place', () => {
    for (const [status, loaders] of [
      [loading, ['balance-loading', 'balance-available-loading', 'balance-unavailable-loading']],
      [totalKnown, ['balance-available-loading', 'balance-unavailable-loading']],
      [ready, []],
      [refreshing, []],
      [failedOverShown, []]
    ] as const) {
      renderCard({ status, isDetailExpanded: true });
      for (const name of ['total', 'available', 'unavailable']) {
        const box = screen.getByTestId(`balance-${name}`);
        // Inside its line, holding exactly the value or its loader.
        expect(box.parentElement?.dataset.testid).toBe(`balance-${name}-line`);
        expect(box.children).toHaveLength(1);
        const held = box.firstElementChild as HTMLElement;
        const loader = name === 'total' ? 'balance-loading' : `balance-${name}-loading`;
        expect(held.dataset.testid).toBe(
          (loaders as readonly string[]).includes(loader)
            ? loader
            : name === 'total'
              ? 'balance-amount'
              : 'balance-split-amount'
        );
      }
      expect(screen.getByTestId('balance-refresh')).toBeTruthy();
      cleanup();
    }
  });

  it('gives the refresh control one size whether it shows its icon or the ring', () => {
    for (const status of [ready, refreshing]) {
      renderCard({ status });
      const box = screen.getByTestId('balance-refresh').firstElementChild as HTMLElement;
      expect([box.style.width, box.style.height]).toEqual([
        `${BALANCE_REFRESH_CONTROL_SIZE}px`,
        `${BALANCE_REFRESH_CONTROL_SIZE}px`
      ]);
      cleanup();
    }
  });

  it.each([
    ['first load', loading],
    ['total known', totalKnown],
    ['ready', ready],
    ['refreshing', refreshing],
    ['failed over a shown value', failedOverShown]
  ])('shows no amount while the balance is hidden: %s', (_state, status) => {
    renderCard({
      status: { ...status, hidden: true },
      isDetailExpanded: true,
      statusText: status.kind === 'refreshing' ? 'Reading 1,240 of 3,346 outputs' : undefined,
      balanceErrorText: status.kind === 'failed' ? 'balance_refresh_error' : undefined
    });

    const text = card().textContent ?? '';
    expect(text).not.toMatch(/0\.0000|0\.91/);
    // The total's and the split's lines keep their heights.
    expect(screen.getByTestId('balance-total-line').style.height).toBe(`${BALANCE_TOTAL_LINE_HEIGHT}px`);
    expect(screen.getByTestId('balance-available-line').style.height).toBe(`${BALANCE_SPLIT_LINE_HEIGHT}px`);
  });
});

type Catalog = Record<string, { message: string } | undefined>;
const LOCALES: [string, Catalog][] = [
  ['en', en],
  ['es', es],
  ['fr', fr],
  ['ja', ja],
  ['ru', ru],
  ['zh_TW', zhTW]
];

describe('BalanceCard copy', () => {
  it('says it is updating, and how far a long read has got, in plain words', () => {
    expect(en.balance_updating.message).toBe('Updating…');
    expect(en.balance_reading_outputs.message).toBe('Reading $1 of $2 outputs');
  });

  it.each(LOCALES)('has both lines in %s, translated, the count with both its numbers', (locale, messages) => {
    for (const key of ['balance_updating', 'balance_reading_outputs']) {
      const message = messages[key]?.message ?? '';
      expect(message.trim(), `${locale} ${key}`).not.toBe('');
      if (locale !== 'en') expect(message, `${locale} ${key}`).not.toBe((en as Catalog)[key]?.message);
    }
    const count = messages.balance_reading_outputs?.message ?? '';
    expect(count.match(/\$\d/g)?.sort(), locale).toEqual(['$1', '$2']);
    expect(messages.balance_updating?.message, locale).not.toMatch(/\$/);
  });

  const OWNER_TEXTS: Record<string, string> = {
    balance_refresh_error: "Balance couldn't be updated and may be out of date. Try refreshing the balance.",
    balance_load_error:
      "Balance couldn't be loaded. The explorer may be temporarily unavailable. Try refreshing the balance.",
    balance_outputs_incomplete:
      "Estimated balance - the wallet couldn't finish reading this account's outputs. Try refreshing the balance.",
    balance_outputs_incomplete_detail: "Breakdown unavailable until wallet finishes reading the account's outputs.",
    utxo_limit_exceeded_balance:
      "Estimated balance - the wallet was unable to load this account's outputs from the explorer.",
    utxo_limit_exceeded_balance_detail: "Breakdown unavailable because the explorer cannot list this account's outputs."
  };

  it('says what failed in the owner’s words (O3)', () => {
    for (const [key, text] of Object.entries(OWNER_TEXTS)) {
      expect((en as Catalog)[key]?.message, key).toBe(text);
    }
  });

  it.each(LOCALES)('has every message of the card in %s, translated, with no placeholder (O3)', (locale, messages) => {
    for (const key of Object.keys(OWNER_TEXTS)) {
      const message = messages[key]?.message ?? '';
      expect(message.trim(), `${locale} ${key}`).not.toBe('');
      if (locale !== 'en') expect(message, `${locale} ${key}`).not.toBe(OWNER_TEXTS[key]);
      expect(message, `${locale} ${key}`).not.toMatch(/\$\d/);
    }
    expect(messages.try_again?.message, `${locale} try_again stays for other screens`).toBeTruthy();
  });
});

// The card with the real balance logic, store and reducer behind it, and the
// wallet's answers given by each test.
describe('BalanceCard with the real logic behind it', () => {
  const address = 'qbit-card-account';
  const shown = {
    availableBalance: 60_000_000,
    unavailableBalance: 31_000_000,
    totalBalance: 91_000_000,
    immatureBalance: 0,
    pendingBalance: 31_000_000,
    chainType: 'QBIT_MAINNET'
  };
  // Read later, with a total that moved since.
  const incomplete = {
    availableBalance: null,
    unavailableBalance: 92_000_000,
    totalBalance: 92_000_000,
    immatureBalance: null,
    pendingBalance: null,
    utxoReadIncomplete: true,
    chainType: 'QBIT_MAINNET'
  };
  const full = { ...shown, availableBalance: 62_000_000, unavailableBalance: 30_000_000, totalBalance: 92_000_000 };

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(useBalanceCardLogic).mockReset();
  });

  async function renderLiveCard(
    wallet: Record<string, unknown>,
    { stored, expanded = true }: { stored?: typeof shown; expanded?: boolean } = {}
  ) {
    const walletState = await vi.importActual<typeof import('@qbit/wallet-state')>('@qbit/wallet-state');
    vi.mocked(useBalanceCardLogic).mockImplementation(walletState.useBalanceCardLogic);
    const store = walletState.createAppStore();
    store.dispatch(
      walletState.accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as never)
    );
    if (stored) {
      store.dispatch(walletState.accountActions.setBalanceV2({ address, balance: stored as never }));
    }
    store.dispatch(walletState.uiActions.setBalanceDetailOpen(expanded));
    const t = (key: string, args?: unknown) => (Array.isArray(args) ? `${key}:${args.join(',')}` : key);
    // The reads the card starts on mounting settle inside act.
    await act(async () => {
      render(
        <Provider store={store}>
          <walletState.I18nContext.Provider value={{ ...defaultI18n, t } as never}>
            <walletState.WalletProvider wallet={wallet as never}>
              <BalanceCard />
            </walletState.WalletProvider>
          </walletState.I18nContext.Provider>
        </Provider>
      );
    });
    return { store, walletState };
  }
  const defaultI18n = {
    locale: 'en',
    supportedLocales: ['en'],
    localeNames: {},
    changeLocale: async () => undefined,
    isSpecialLocale: false
  };

  const splitAmounts = () => screen.queryAllByTestId('balance-split-amount').map((element) => element.textContent);
  const expectNoStackedState = () => {
    // The state a user saw in 1.0.10, a warning, Try again, a sentence that
    // the outputs could not be read and `--` for both, all at once, cannot
    // happen: one message at most, `--` for the split only beside the note
    // that says why, and no button.
    const box = screen.queryAllByTestId('balance-error');
    const note = screen.queryAllByTestId('balance-outputs-note');
    expect(box.length + note.length).toBeLessThanOrEqual(1);
    if (note.length === 0) expect(splitAmounts()).not.toContain('--');
    expect(screen.queryByRole('button', { name: 'try_again' })).toBeNull();
  };

  const sameTotal = { ...incomplete, unavailableBalance: 91_000_000, totalBalance: 91_000_000 };
  it.each([
    ['ran out of time part of the way through', sameTotal],
    ['failed', { ...sameTotal, utxoReadFailed: true }]
  ])(
    'keeps the last figures dimmed, with no message, when a refresh %s; a full answer brings them back',
    async (_how, answer) => {
      vi.useFakeTimers();
      // The card reads at once on mounting over the balance shown.
      await renderLiveCard(
        { getAddressBalanceV2: vi.fn().mockResolvedValueOnce(answer).mockResolvedValue(full) },
        { stored: shown }
      );

      expect(card().dataset.status).toBe('refreshing');
      expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
      expect(splitAmounts()).toEqual(['0.60000000', '0.31000000']);
      expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
      // Nothing reads until the next poll: dimmed, but no word and no ring
      // (round 3, item 4).
      expect(screen.queryByTestId('balance-status-text')).toBeNull();
      expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('false');
      expect(screen.queryByTestId('balance-error')).toBeNull();
      expectNoStackedState();

      // The poll reads again: 10 s after the last read, or the back-off after a failure.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(card().dataset.status).toBe('ready'));
      expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
      expect(splitAmounts()).toEqual(['0.62000000', '0.30000000']);
      expect(opacityOf('balance-total-line')).toBe('1');
    }
  );

  it('shows the total and loaders, not `--` and a sentence, when the first read cannot read every output, and reads again 1.5 s later', async () => {
    vi.useFakeTimers();
    const getAddressBalanceV2 = vi
      .fn()
      .mockResolvedValueOnce({ ...incomplete, utxoReadFailed: true })
      .mockResolvedValue(full);
    await renderLiveCard({ getAddressBalanceV2 });
    // The poll's first read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(card().dataset.status).toBe('total');
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
    expect(loaderHeights()).toEqual([
      ['balance-available-loading', BALANCE_SPLIT_LINE_HEIGHT],
      ['balance-unavailable-loading', BALANCE_SPLIT_LINE_HEIGHT]
    ]);
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expectNoStackedState();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(getAddressBalanceV2).toHaveBeenCalledTimes(2);
    expect(card().dataset.status).toBe('ready');
    expect(splitAmounts()).toEqual(['0.62000000', '0.30000000']);
  });

  /** Reads the background answers when the test says. */
  function heldReads() {
    const reads: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; progressId?: string }> = [];
    const getAddressBalanceV2 = (_address: string, options?: { progressId?: string }) =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject, progressId: options?.progressId });
      });
    return { reads, getAddressBalanceV2 };
  }

  it.each([
    ['an incomplete answer, then a rejected read', ['incomplete', 'reject'] as const],
    ['a rejected read, then an older incomplete answer', ['reject-newer', 'incomplete-older'] as const]
  ])(
    'never shows the warning, the outputs sentence and `--` together: %s, then a failure shown alone',
    async (_case, steps) => {
      vi.useFakeTimers();
      const background = heldReads();
      const { store, walletState } = await renderLiveCard({ getAddressBalanceV2: background.getAddressBalanceV2 });
      const fetchBalanceOf = () => {
        // A read beside the card's, as the account updater's or a refresh after a broadcast.
        let fetchBalance!: () => Promise<unknown>;
        const Reader = () => {
          fetchBalance = walletState.useStartBalanceReadCallback();
          return null;
        };
        render(
          <Provider store={store}>
            <walletState.WalletProvider wallet={{ getAddressBalanceV2: background.getAddressBalanceV2 } as never}>
              <Reader />
            </walletState.WalletProvider>
          </Provider>
        );
        return fetchBalance;
      };
      const fetchBalance = fetchBalanceOf();
      let older!: Promise<unknown>;
      let newer!: Promise<unknown>;
      act(() => {
        older = fetchBalance().catch(() => undefined);
        newer = fetchBalance().catch(() => undefined);
      });

      if (steps[0] === 'incomplete') {
        await act(async () => {
          background.reads[0].resolve(incomplete);
          await older;
        });
        expect(card().dataset.status).toBe('total');
        expectNoStackedState();
        await act(async () => {
          background.reads[1].reject(new Error('explorer down'));
          await newer;
        });
      } else {
        await act(async () => {
          background.reads[1].reject(new Error('explorer down'));
          await newer;
        });
        expect(card().dataset.status).toBe('loading');
        expectNoStackedState();
        await act(async () => {
          background.reads[0].resolve(incomplete);
          await older;
        });
      }
      // One failure is no failure shown yet: the total, loaders for the split.
      expect(card().dataset.status).toBe('total');
      expect(screen.queryByTestId('balance-error')).toBeNull();
      expectNoStackedState();

      // Thirty seconds after the failed read began, still no complete
      // answer: the total, the note that the outputs could not be read, and
      // `--` for the split with its own note; no box, nothing spinning (O4).
      // The total is the older read's, out of date: dimmed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(card().dataset.status).toBe('failed');
      expect(screen.queryByTestId('balance-error')).toBeNull();
      expect(screen.getByTestId('balance-outputs-note').textContent).toBe('balance_outputs_incomplete');
      expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
      expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
      expect(splitAmounts()).toEqual(['--', '--']);
      expect(screen.getByTestId('balance-outputs-detail-note')).toBeTruthy();
      expect(loaderHeights()).toEqual([]);
      expect(screen.queryAllByRole('status')).toEqual([]);
      expectNoStackedState();
    }
  );

  it('shows the kept balance of the background dimmed at open, then the total as the statistics answer, then the split, and the count of a long read', async () => {
    vi.useFakeTimers();
    const background = heldReads();
    const kept = {
      balance: { ...shown, totalBalance: 90_000_000, unavailableBalance: 30_000_000 },
      readAt: Date.now() - 60_000
    };
    const { walletState } = await renderLiveCard({
      getAddressBalanceV2: background.getAddressBalanceV2,
      getKeptAddressBalance: vi.fn().mockResolvedValue(kept)
    });
    // With no account updater here, nothing reads before the poll at 10 s:
    // the kept answer shows dimmed until then, as read before, and stays
    // dimmed as that read begins, with no quiet start (item 2).
    expect(card().dataset.status).toBe('refreshing');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(card().dataset.status).toBe('refreshing');
    expect(screen.getByTestId('balance-refresh').dataset.spinning).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(card().dataset.status).toBe('refreshing');
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.90000000');
    expect(opacityOf('balance-total-line')).toBe(String(BALANCE_TOTAL_DIMMED_OPACITY));
    expect(screen.getByTestId('balance-status-text').textContent).toBe('balance_updating');
    expect(background.reads).toHaveLength(1);
    const { progressId } = background.reads[0];
    expect(progressId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    // The statistics answer with another total: it shows at once, the split loading.
    await act(async () => {
      walletState.uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId,
        kind: 'total',
        address,
        chainType: 'QBIT_MAINNET',
        totalBalance: 92_000_000
      });
    });
    expect(card().dataset.status).toBe('total');
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
    expect(opacityOf('balance-total-line')).toBe('1');

    // Three seconds into the read, its count shows in words.
    await act(async () => {
      walletState.uiEventBus.emit(QBIT_BALANCE_READ_PROGRESS, {
        progressId,
        kind: 'outputs',
        address,
        chainType: 'QBIT_MAINNET',
        read: 1_240,
        total: 3_346
      });
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // In short beside the control; the full sentence is the control's description.
    expect(screen.getByTestId('balance-status-text').textContent).toBe('1,240 / 3,346');
    const control = screen.getByTestId('balance-refresh');
    expect(control.getAttribute('aria-label')).toBe('refresh_balance');
    expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'balance_reading_outputs:1,240,3,346'
    );

    await act(async () => {
      background.reads[0].resolve(full);
    });
    expect(card().dataset.status).toBe('ready');
    expect(splitAmounts()).toEqual(['0.62000000', '0.30000000']);
    expect(screen.queryByTestId('balance-status-text')).toBeNull();
  });
});
