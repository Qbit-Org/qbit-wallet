import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { colors } from '@/ui/theme/colors';
import { useBalanceCardLogic } from '@qbit/wallet-state';
import { Provider } from 'react-redux';

import en from '../../../../../_locales/en/messages.json';
import es from '../../../../../_locales/es/messages.json';
import fr from '../../../../../_locales/fr/messages.json';
import ja from '../../../../../_locales/ja/messages.json';
import ru from '../../../../../_locales/ru/messages.json';
import zhTW from '../../../../../_locales/zh_TW/messages.json';
import { BalanceCard } from './BalanceCard';

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
  }) =>
    React.createElement(
      'div',
      { style, onClick, 'data-testid': dataTestId, 'data-background': style?.backgroundColor },
      children
    );
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('span', { 'data-icon': icon });
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
  const Spin = () => React.createElement('span', { 'data-testid': 'spin' });
  const Button = ({
    text,
    preset,
    loading,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    preset?: string;
    loading?: boolean;
    onClick?: MouseEventHandler;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      { disabled: loading, onClick, 'data-testid': dataTestId, 'data-preset': preset },
      text
    );
  return { Button, Column: Container, Icon, Row: Container, Spin, Text, Tooltip };
});
vi.mock('@/ui/components/RefreshButton', () => ({ RefreshButton: () => null }));
vi.mock('./QbitDisplay', async () => {
  const React = await import('react');
  return {
    QbitDisplay: ({ balance, preset }: { balance: string; preset?: string }) =>
      React.createElement(
        'span',
        { 'data-testid': preset === 'sub' ? 'balance-split-amount' : 'balance-amount' },
        balance
      )
  };
});
// The card's logic is given by each test; the rest of the package is real, for
// the tests that put the real logic, store and reducer behind the card.
vi.mock('@qbit/wallet-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qbit/wallet-state')>()),
  useBalanceCardLogic: vi.fn()
}));

function renderCard(state: Partial<ReturnType<typeof useBalanceCardLogic>>) {
  const logic = {
    availableAmount: '0.00005000',
    unavailableAmount: '0.00000000',
    unavailableTipText: 'unavailable_tooltip',
    balanceValue: '0.00005000',
    t: (key: string) => key,
    isCurrentChainBalance: true,
    utxoLimitExceeded: false,
    utxoLimitExceededText: 'utxo_limit_exceeded_balance',
    balanceSplitUnknown: false,
    balanceSplitUnknownText: 'utxo_limit_exceeded_balance_detail',
    utxoReadIncomplete: false,
    utxoReadIncompleteText: 'balance_outputs_incomplete',
    utxoReadIncompleteDetailText: 'balance_outputs_incomplete_detail',
    balanceLoading: false,
    balanceLoadFailed: false,
    balanceErrorText: undefined,
    isDetailExpanded: false,
    handleExpandToggle: vi.fn(),
    isBalanceHidden: false,
    handleHiddenToggle: vi.fn(),
    refreshBalance: vi.fn(),
    retryBalance: vi.fn(),
    isRetryingBalance: false,
    ...state
  };
  vi.mocked(useBalanceCardLogic).mockReturnValue(logic as unknown as ReturnType<typeof useBalanceCardLogic>);
  render(<BalanceCard />);
  return logic;
}

const overLimit = {
  availableAmount: '--',
  unavailableAmount: '--',
  balanceValue: '0.91000000',
  utxoLimitExceeded: true,
  balanceSplitUnknown: true
};

// The outputs are not all read yet: the total is measured, the split is not.
const outputsIncomplete = {
  availableAmount: '--',
  unavailableAmount: '--',
  balanceValue: '0.91000000',
  utxoReadIncomplete: true
};

const expectNoIncompleteNotes = () => {
  expect(screen.queryByTestId('balance-outputs-incomplete-note')).toBeNull();
  expect(screen.queryByTestId('balance-outputs-incomplete-detail')).toBeNull();
};

describe('BalanceCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the split as unknown, with a line saying why, past the explorer UTXO limit (#341)', () => {
    renderCard({ ...overLimit, isDetailExpanded: true });

    const card = screen.getByTestId('wallet-balance-card');
    expect(card.textContent).toContain('0.91000000');
    expect(card.textContent).toContain('available--');
    expect(card.textContent).toContain('unavailable--');
    expect(card.textContent).not.toContain('0.00000000');
    expect(screen.getByTestId('balance-utxo-limit-note').textContent).toBe('utxo_limit_exceeded_balance');
    expect(screen.getByTestId('balance-split-unknown-note').textContent).toBe('utxo_limit_exceeded_balance_detail');
    // The tooltip explaining a measured Unavailable is not offered for an unknown one.
    expect(screen.queryByTestId('tooltip:rich')).toBeNull();
    expectNoIncompleteNotes();
  });

  it('shows the total with a note, and the split as unknown with a line saying why, while the outputs are still being read', () => {
    renderCard({ ...outputsIncomplete, isDetailExpanded: true });

    const card = screen.getByTestId('wallet-balance-card');
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(card.textContent).toContain('available--');
    expect(card.textContent).toContain('unavailable--');
    expect(screen.getByTestId('balance-outputs-incomplete-note').textContent).toBe('balance_outputs_incomplete');
    expect(screen.getByTestId('balance-outputs-incomplete-detail').textContent).toBe(
      'balance_outputs_incomplete_detail'
    );
    // The detail line takes the place of the tooltip explaining a measured Unavailable.
    expect(screen.queryByTestId('tooltip:rich')).toBeNull();
    // Neither the explorer's limit nor an error, and no spinner: the total is loaded.
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.queryByTestId('balance-loading')).toBeNull();
    expect(card.dataset.background).toBe(colors.accent);
  });

  it('shows the outputs line only in the expanded rows', () => {
    renderCard({ ...outputsIncomplete, isDetailExpanded: false });

    expect(screen.getByTestId('balance-outputs-incomplete-note')).toBeTruthy();
    expect(screen.queryByTestId('balance-outputs-incomplete-detail')).toBeNull();
  });

  it('keeps the total and the outputs note next to the refresh error', () => {
    renderCard({ ...outputsIncomplete, isDetailExpanded: true, balanceErrorText: 'balance_refresh_error' });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-outputs-incomplete-note')).toBeTruthy();
    expect(screen.getByTestId('balance-outputs-incomplete-detail')).toBeTruthy();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
  });

  it('labels the balance visibility toggle and the refresh button', () => {
    renderCard({ isBalanceHidden: false });
    expect(screen.getByTestId('tooltip:hide_balance').contains(screen.getByTestId('balance-visibility-toggle'))).toBe(
      true
    );
    expect(screen.getByTestId('tooltip:refresh_balance')).toBeTruthy();
    cleanup();

    renderCard({ isBalanceHidden: true });
    expect(screen.getByTestId('tooltip:show_balance')).toBeTruthy();
    expect(screen.queryByTestId('tooltip:hide_balance')).toBeNull();
  });

  it('shows the split line only in the expanded rows', () => {
    renderCard({ ...overLimit, isDetailExpanded: false });

    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
  });

  it('shows measured amounts and no unknown line for an ordinary balance', () => {
    renderCard({ isDetailExpanded: true, unavailableTipText: 'Locked due to:\n• Protected assets\n• Unconfirmed' });

    const card = screen.getByTestId('wallet-balance-card');
    expect(card.textContent).toContain('available0.00005000');
    expect(card.textContent).toContain('unavailable0.00000000');
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
    expectNoIncompleteNotes();
  });

  it('shows the load error and a retry instead of a zero balance', () => {
    const logic = renderCard({
      balanceValue: '0.00000000',
      balanceLoadFailed: true,
      balanceErrorText: 'balance_load_error',
      isDetailExpanded: true
    });

    expect(screen.queryByTestId('balance-amount')).toBeNull();
    // Nothing loaded, so there is no breakdown either.
    expect(screen.queryByTestId('balance-split-amount')).toBeNull();
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_load_error');
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.neutralFill);
    expect(screen.getByTestId('balance-retry-button').dataset.preset).toBe('neutral');

    fireEvent.click(screen.getByTestId('balance-retry-button'));
    expect(logic.retryBalance).toHaveBeenCalledTimes(1);
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
    expectNoIncompleteNotes();
  });

  it('keeps the last balance next to the refresh error', () => {
    renderCard({ balanceErrorText: 'balance_refresh_error' });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-retry-button')).toBeTruthy();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
    expect(screen.getByTestId('balance-retry-button').dataset.preset).toBe('default');
  });

  it('keeps an over-limit balance and its unknown split next to the refresh error', () => {
    renderCard({ ...overLimit, isDetailExpanded: true, balanceErrorText: 'balance_refresh_error' });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(screen.getByTestId('balance-error-note').textContent).toBe('balance_refresh_error');
    expect(screen.getByTestId('balance-utxo-limit-note')).toBeTruthy();
    expect(screen.getByTestId('balance-split-unknown-note')).toBeTruthy();
    expect(screen.getByTestId('wallet-balance-card').textContent).toContain('available--');
  });

  it('does not toggle the card while a retry is running', () => {
    const logic = renderCard({ balanceErrorText: 'balance_refresh_error', isRetryingBalance: true });

    expect((screen.getByTestId('balance-retry-button') as HTMLButtonElement).disabled).toBe(true);
    // The real Button drops its handler while loading, so the click reaches the error block.
    fireEvent.click(screen.getByTestId('balance-error'));
    expect(logic.retryBalance).not.toHaveBeenCalled();
    expect(logic.handleExpandToggle).not.toHaveBeenCalled();
  });

  it('shows `--` on the brand fill, with no error and no breakdown, before the first read while the balance is hidden', () => {
    renderCard({
      isCurrentChainBalance: false,
      balanceLoading: true,
      isBalanceHidden: true,
      balanceValue: '--',
      availableAmount: '--',
      unavailableAmount: '--',
      isDetailExpanded: true
    });

    expect(screen.getByTestId('balance-amount').textContent).toBe('--');
    expect(screen.queryByTestId('balance-loading')).toBeNull();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.queryByTestId('balance-split-amount')).toBeNull();
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(document.querySelector('[data-icon="down"], [data-icon="up"]')).toBeNull();
  });

  it('shows the split as `--` with no explorer note and no error while a broadcast holds the send guard', () => {
    renderCard({
      balanceValue: '0.91000000',
      availableAmount: '--',
      unavailableAmount: '--',
      isDetailExpanded: true
    });

    const card = screen.getByTestId('wallet-balance-card');
    expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
    expect(card.textContent).toContain('available--');
    expect(card.textContent).toContain('unavailable--');
    expect(screen.queryByTestId('balance-utxo-limit-note')).toBeNull();
    expect(screen.queryByTestId('balance-split-unknown-note')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    // Nor the line for outputs still being read: that is another unknown split.
    expectNoIncompleteNotes();
  });

  it('shows no error without a failed refresh', () => {
    renderCard({});

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.00005000');
    expect(screen.queryByTestId('balance-error')).toBeNull();
  });

  it('shows a spinner instead of a zero balance while the first balance loads', () => {
    renderCard({ balanceLoading: true, balanceValue: '--', isDetailExpanded: true });

    expect(screen.getByRole('status', { name: 'balance_loading' })).toBeTruthy();
    expect(screen.queryByTestId('balance-amount')).toBeNull();
    expect(screen.queryByTestId('balance-error')).toBeNull();
    expect(screen.getByTestId('wallet-balance-card').dataset.background).toBe(colors.accent);
    // No breakdown, or chevron to open one, until a balance loads.
    expect(screen.queryByText('available')).toBeNull();
    expect(document.querySelector('[data-icon="down"], [data-icon="up"]')).toBeNull();
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
const OUTPUTS_INCOMPLETE_KEYS = ['balance_outputs_incomplete', 'balance_outputs_incomplete_detail'];

describe('BalanceCard copy for outputs still being read', () => {
  it('says why only the total is shown, without blaming the explorer', () => {
    expect(en.balance_outputs_incomplete.message).toBe(
      'The wallet could not finish reading this account\u0027s outputs, so only the total is shown. It will try again.'
    );
    expect(en.balance_outputs_incomplete_detail.message).toBe(
      'Available and unavailable amounts are unknown until the wallet finishes reading this account\u0027s outputs.'
    );
  });

  it.each(LOCALES)('has both lines in %s, translated and without placeholders', (locale, messages) => {
    for (const key of OUTPUTS_INCOMPLETE_KEYS) {
      const message = messages[key]?.message ?? '';
      expect(message.trim(), `${locale} ${key}`).not.toBe('');
      expect(message, `${locale} ${key}`).not.toMatch(/\$/);
      if (locale !== 'en') {
        expect(message, `${locale} ${key}`).not.toBe((en as Catalog)[key]?.message);
      }
    }
  });
});

// The card with the real balance logic, store and reducer behind it, and the
// wallet's answers given by each test.
describe('BalanceCard when a read cannot read every output', () => {
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

  async function renderLiveCard(getAddressBalanceV2: ReturnType<typeof vi.fn>, stored?: typeof shown) {
    const walletState = await vi.importActual<typeof import('@qbit/wallet-state')>('@qbit/wallet-state');
    vi.mocked(useBalanceCardLogic).mockImplementation(walletState.useBalanceCardLogic);
    const store = walletState.createAppStore();
    store.dispatch(
      walletState.accountActions.setCurrent({ address, pubkey: '11'.repeat(32), type: 'Qbit HD Key Tree' } as never)
    );
    if (stored) {
      store.dispatch(walletState.accountActions.setBalanceV2({ address, balance: stored as never }));
    }
    // The reads the card starts on mounting settle inside act.
    await act(async () => {
      render(
        <Provider store={store}>
          <walletState.WalletProvider wallet={{ getAddressBalanceV2 } as never}>
            <BalanceCard />
          </walletState.WalletProvider>
        </Provider>
      );
    });
  }

  const splitAmounts = () => screen.getAllByTestId('balance-split-amount').map((element) => element.textContent);

  it.each([
    ['ran out of time part of the way through', incomplete],
    ['failed', { ...incomplete, utxoReadFailed: true }]
  ])(
    'keeps the last figures with the refresh error and Try again, and no outputs note, when it %s; Try again with a full answer clears it',
    async (_how, answer) => {
      // The card reads at once on mounting over the balance shown.
      await renderLiveCard(vi.fn().mockResolvedValueOnce(answer).mockResolvedValue(full), shown);

      expect((await screen.findByTestId('balance-error-note')).textContent).toBe('balance_refresh_error');
      expect(screen.getByTestId('balance-amount').textContent).toBe('0.91000000');
      expect(splitAmounts()).toEqual(['0.60000000', '0.31000000']);
      expect(screen.getByTestId('balance-retry-button').dataset.preset).toBe('default');
      expectNoIncompleteNotes();

      await act(async () => {
        fireEvent.click(screen.getByTestId('balance-retry-button'));
      });
      await waitFor(() => expect(screen.queryByTestId('balance-error')).toBeNull());
      expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
      expect(splitAmounts()).toEqual(['0.62000000', '0.30000000']);
    }
  );

  it('shows the total, `--` and the note, with no error box, when the first read cannot read every output', async () => {
    vi.useFakeTimers();
    await renderLiveCard(vi.fn().mockResolvedValue({ ...incomplete, utxoReadFailed: true }));
    // The poll's first read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByTestId('balance-amount').textContent).toBe('0.92000000');
    expect(splitAmounts()).toEqual(['--', '--']);
    expect(screen.getByTestId('balance-outputs-incomplete-note').textContent).toBe('balance_outputs_incomplete');
    expect(screen.queryByTestId('balance-error')).toBeNull();
  });
});
