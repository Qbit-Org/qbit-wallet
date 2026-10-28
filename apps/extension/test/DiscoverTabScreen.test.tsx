import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let currentChainType = 'QBIT_TESTNET4';

vi.mock('@qbit/wallet-state', () => ({
  useChainType: () => currentChainType,
  useI18n: () => ({ t: (key: string) => key }),
  useNavigation: () => ({ navigate: vi.fn(), navToLock: vi.fn() })
}));

vi.mock('@/ui/components', () => {
  const Container = ({ children, 'data-testid': testId }: any) => <div data-testid={testId}>{children}</div>;

  return {
    Column: Container,
    Content: Container,
    Footer: Container,
    Layout: Container,
    Row: Container,
    Header: ({ LeftComponent, RightComponent }: any) => (
      <header>
        {LeftComponent}
        {RightComponent}
      </header>
    ),
    Icon: ({ icon }: any) => <span data-icon={icon} />,
    Image: ({ src, size }: any) => <img src={src} width={size} height={size} alt="" />,
    Text: ({ text }: any) => <span>{text}</span>,
    Button: ({ text, disabled, onClick, 'data-testid': testId }: any) => (
      <button data-testid={testId} disabled={disabled} onClick={disabled ? undefined : onClick}>
        {text}
      </button>
    ),
    Checkbox: ({ checked, onChange, children, 'data-testid': testId }: any) => (
      <label data-testid={testId}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange?.({ target: { checked: event.target.checked } })}
          data-testid={testId ? `${testId}-input` : undefined}
        />
        {children}
      </label>
    )
  };
});

vi.mock('@/ui/components/BottomModal', () => ({
  BottomModal: ({ children }: any) => <div data-testid="bottom-modal">{children}</div>
}));

vi.mock('@/ui/components/NavTabBar', () => ({
  NavTabBar: () => <nav data-testid="nav-tab-bar" />
}));

vi.mock('@/ui/components/SwitchNetworkBar', () => ({
  SwitchNetworkBar: () => <div data-testid="switch-network-bar" />
}));

vi.mock('../src/ui/pages/Main/ecosystemNavigation', () => ({
  openEcosystemEntry: vi.fn().mockResolvedValue(undefined)
}));

import DiscoverTabScreen from '../src/ui/pages/Main/DiscoverTabScreen';
import { ECOSYSTEM_WARNING_ACK_STORAGE_KEY } from '../src/ui/pages/Main/EcosystemWarningModal';
import { openEcosystemEntry } from '../src/ui/pages/Main/ecosystemNavigation';

describe('DiscoverTabScreen', () => {
  beforeEach(() => {
    currentChainType = 'QBIT_TESTNET4';
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the two community catalog entries on Testnet4 and opens by catalog ID', () => {
    localStorage.setItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY, 'true');
    render(<DiscoverTabScreen />);

    expect(screen.getByText('Qbit Testnet Faucet')).toBeTruthy();
    expect(screen.getByText('Qbit Testnet Pool')).toBeTruthy();
    expect(
      screen.getByText(
        'A community-run faucet that dispenses QBT on the public testnet4 network for development and testing. Sends 1 QBT per request on a 24-hour cooldown, and lets you return unused coins so they recirculate to other builders.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        'A hosted Qbit mining pool for the public Qbit testnet, powered by the open-source PRISM software. It lets miners work on the permissionless lane and receive payouts on-chain.'
      )
    ).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    // The warning lives only in the acknowledgement modal, never in the body.
    expect(screen.queryByText('ecosystem_community_warning')).toBeNull();
    expect(screen.queryByText('Community ecosystem')).toBeNull();
    expect(screen.queryByText(/Community-operated/)).toBeNull();
    expect(screen.queryByText(/Opening a listing does not connect your wallet/)).toBeNull();
    // Entry artwork renders as mask tiles at the compact 24px size.
    const artworkTiles = screen.getAllByTestId('ecosystem-artwork-tile');
    expect(artworkTiles).toHaveLength(2);
    artworkTiles.forEach((tile) => {
      expect(tile.style.width).toBe('24px');
      expect(tile.style.height).toBe('24px');
    });
    expect(screen.queryByTestId('ecosystem-empty-state')).toBeNull();

    fireEvent.click(screen.getByTestId('ecosystem-entry-qbit-testnet-faucet'));

    expect(openEcosystemEntry).toHaveBeenCalledTimes(1);
    expect(openEcosystemEntry).toHaveBeenCalledWith('qbit-testnet-faucet');
  });

  it('renders the four community catalog entries on Mainnet in catalog order and opens by catalog ID', () => {
    currentChainType = 'QBIT_MAINNET';
    localStorage.setItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY, 'true');

    render(<DiscoverTabScreen />);

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'ecosystem-entry-prism-pool',
      'ecosystem-entry-qbit-block-visualizer',
      'ecosystem-entry-qbit-testnet-faucet-mainnet',
      'ecosystem-entry-qbit-rich-list'
    ]);
    expect(screen.getByText('Qbit Pool')).toBeTruthy();
    expect(screen.getByText('Qbit Block Visualizer')).toBeTruthy();
    expect(screen.getByText('Qbit Testnet Faucet')).toBeTruthy();
    expect(screen.getByText('Qbit Rich List')).toBeTruthy();
    expect(screen.queryByText(/Community-operated/)).toBeNull();
    expect(screen.queryByTestId('ecosystem-empty-state')).toBeNull();

    fireEvent.click(screen.getByTestId('ecosystem-entry-prism-pool'));

    expect(openEcosystemEntry).toHaveBeenCalledTimes(1);
    expect(openEcosystemEntry).toHaveBeenCalledWith('prism-pool');
  });

  it('renders an empty state on QBIT_REGTEST', () => {
    currentChainType = 'QBIT_REGTEST';
    localStorage.setItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY, 'true');

    render(<DiscoverTabScreen />);

    expect(screen.getByTestId('ecosystem-empty-state')).toBeTruthy();
    expect(screen.getByText('No ecosystem tools are listed for this network.')).toBeTruthy();
    expect(screen.queryByTestId('ecosystem-entry-qbit-testnet-faucet')).toBeNull();
    expect(screen.queryByTestId('ecosystem-entry-prism-testnet-pool')).toBeNull();
    expect(screen.queryByTestId('ecosystem-entry-prism-pool')).toBeNull();
    expect(screen.queryByTestId('ecosystem-entry-qbit-rich-list')).toBeNull();
  });

  it('gates the first visit behind the acknowledgement modal and persists Continue', () => {
    const { unmount } = render(<DiscoverTabScreen />);

    const modal = screen.getByTestId('ecosystem-warning-modal');
    expect(within(modal).getByText('ecosystem_community_warning')).toBeTruthy();
    // The warning copy exists only inside the modal, not in the screen body.
    expect(screen.getAllByText('ecosystem_community_warning')).toHaveLength(1);
    // The listings render behind the modal so the screen is not blank under
    // the overlay, but the subtree is inert and hidden from assistive tech so
    // nothing behind the modal is tabbable, clickable or Enter-activatable.
    expect(screen.getByTestId('ecosystem-entry-qbit-testnet-faucet')).toBeTruthy();
    expect(screen.getByTestId('ecosystem-entry-prism-testnet-pool')).toBeTruthy();
    expect(screen.getAllByTestId('ecosystem-artwork-tile')).toHaveLength(2);
    const gatedListings = screen.getByTestId('ecosystem-listings');
    expect(gatedListings.hasAttribute('inert')).toBe(true);
    expect(gatedListings.getAttribute('aria-hidden')).toBe('true');
    // Only the modal's own buttons are exposed while the listings are gated.
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'ecosystem-warning-back',
      'ecosystem-warning-continue'
    ]);

    const continueButton = screen.getByTestId('ecosystem-warning-continue') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(screen.getByTestId('ecosystem-warning-modal')).toBeTruthy();

    fireEvent.click(screen.getByTestId('ecosystem-warning-understand-input'));
    expect((screen.getByTestId('ecosystem-warning-continue') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('ecosystem-warning-continue'));
    expect(screen.queryByTestId('ecosystem-warning-modal')).toBeNull();
    expect(screen.queryByText('ecosystem_community_warning')).toBeNull();
    expect(localStorage.getItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY)).toBe('true');
    // Acknowledgement lifts the gate in place: the same listings become
    // focusable and accessible again without remounting.
    const listings = screen.getByTestId('ecosystem-listings');
    expect(listings.hasAttribute('inert')).toBe(false);
    expect(listings.hasAttribute('aria-hidden')).toBe(false);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'ecosystem-entry-qbit-testnet-faucet',
      'ecosystem-entry-prism-testnet-pool'
    ]);
    fireEvent.click(screen.getByTestId('ecosystem-entry-qbit-testnet-faucet'));
    expect(openEcosystemEntry).toHaveBeenCalledWith('qbit-testnet-faucet');

    // A full teardown and reopen must not resurface the modal.
    unmount();
    render(<DiscoverTabScreen />);
    expect(screen.queryByTestId('ecosystem-warning-modal')).toBeNull();
  });

  it('never shows the modal when the acknowledgement is already persisted', () => {
    localStorage.setItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY, 'true');

    render(<DiscoverTabScreen />);

    expect(screen.queryByTestId('ecosystem-warning-modal')).toBeNull();
    expect(screen.queryByText('ecosystem_community_warning')).toBeNull();
    const listings = screen.getByTestId('ecosystem-listings');
    expect(listings.hasAttribute('inert')).toBe(false);
    expect(listings.hasAttribute('aria-hidden')).toBe(false);
  });
});
