import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('@qbit/wallet-state', () => ({
  useNavigation: () => ({ navigate })
}));

vi.mock('@/ui/components/Icon', () => ({
  Icon: ({ icon }: any) => <span data-icon={icon} />
}));

import { NavTabBar } from '../src/ui/components/NavTabBar';
import { MINE_TAB_SEEN_STORAGE_KEY } from '../src/ui/components/NavTabBar/mineTabSeen';

describe('NavTabBar Mine badge', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    navigate.mockClear();
  });

  it('shows NEW beside Mine until the Mine tab is first opened', () => {
    render(<NavTabBar tab="home" />);

    expect(screen.getByTestId('tab-new-badge').textContent).toBe('NEW');

    fireEvent.click(screen.getByTestId('tab-mine'));

    expect(navigate).toHaveBeenCalledWith('MineTabScreen');
    expect(localStorage.getItem(MINE_TAB_SEEN_STORAGE_KEY)).toBe('true');

    cleanup();
    render(<NavTabBar tab="home" />);
    expect(screen.queryByTestId('tab-new-badge')).toBeNull();
  });

  it('hides the badge while the Mine tab is active', () => {
    render(<NavTabBar tab="mine" />);

    expect(screen.queryByTestId('tab-new-badge')).toBeNull();
  });
});
