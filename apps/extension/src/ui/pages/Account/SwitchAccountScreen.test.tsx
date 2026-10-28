import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyringType } from '@qbit/keyring-service/types';
import {
  useAppDispatch,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n,
  useNavigation,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import SwitchAccountScreen, { MyItem } from './SwitchAccountScreen';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn()
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: (event: unknown) => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  const Button = ({
    text,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    onClick?: (event: unknown) => void;
    'data-testid'?: string;
  }) => React.createElement('button', { onClick, 'data-testid': dataTestId }, text);
  const Header = ({ children, RightComponent }: { children?: ReactNode; RightComponent?: ReactNode }) =>
    React.createElement('div', null, children, RightComponent);

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Icon: Container,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/pages/MainRoute', () => ({
  useNavigate: () => mocks.navigate
}));

vi.mock('@/ui/theme/colors', () => ({
  colors: {
    accent: '',
    accentDark: '',
    accentWash: '',
    border: '',
    shadow: '',
    surface: '',
    white_muted2: ''
  }
}));

vi.mock('@/ui/utils', () => ({
  copyToClipboard: vi.fn(),
  shortAddress: (value = '') => value
}));

vi.mock('lucide-react', async () => {
  const React = await import('react');
  const actual = await vi.importActual<typeof import('lucide-react')>('lucide-react');
  return {
    ...actual,
    Ellipsis: () => React.createElement('span', { 'data-testid': 'account-options-trigger' })
  };
});

vi.mock('@qbit/wallet-state', () => ({
  accountActions: { setCurrent: vi.fn() },
  useAppDispatch: vi.fn(),
  useCurrentAccount: vi.fn(),
  useCurrentKeyring: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

function renderAccountItem(keyringType: KeyringType) {
  const account = {
    address: 'bc1qaccount',
    alianName: 'Account 1',
    flag: 0,
    index: 0,
    key: 'keyring_0#0',
    pubkey: 'account-pubkey',
    type: keyringType
  };
  const keyring = {
    accountIndexDerivation: false,
    accounts: [account],
    addressType: 0,
    alianName: 'Wallet 1',
    hdPath: `m/84'/0'/0'/0`,
    index: 0,
    key: 'keyring_0',
    type: keyringType
  };

  vi.mocked(useCurrentAccount).mockReturnValue(account as any);
  vi.mocked(useCurrentKeyring).mockReturnValue(keyring as any);
  render(<MyItem account={account as any} />);
  fireEvent.click(screen.getByTestId('account-options-trigger'));

  return { account, keyring };
}

describe('SwitchAccountScreen account dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useAppDispatch).mockReturnValue(vi.fn() as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue({ toastSuccess: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ changeKeyring: vi.fn(), getCurrentAccount: vi.fn() } as any);
  });

  it.each([
    [KeyringType.HdKeyring, true, true],
    [KeyringType.QbitHdKeyring, true, false],
    [KeyringType.SimpleKeyring, false, true],
    [KeyringType.WatchAddressKeyring, false, false]
  ])('shows supported actions for %s', (keyringType, showsBackup, showsPrivateKeyExport) => {
    renderAccountItem(keyringType);

    expect(screen.queryByText('show_secret_recovery_phrase') !== null).toBe(showsBackup);
    expect(screen.queryByText('export_private_key') !== null).toBe(showsPrivateKeyExport);
  });

  it.each([KeyringType.HdKeyring, KeyringType.QbitHdKeyring])(
    'backs up the current %s keyring through the password-gated export screen',
    (keyringType) => {
      const { account, keyring } = renderAccountItem(keyringType);

      fireEvent.click(screen.getByText('show_secret_recovery_phrase'));

      expect(mocks.navigate).toHaveBeenCalledWith('ExportMnemonicsScreen', { keyring });
      expect(mocks.navigate).not.toHaveBeenCalledWith('ExportMnemonicsScreen', { keyring: account });
    }
  );
});

describe('SwitchAccountScreen account list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useAppDispatch).mockReturnValue(vi.fn() as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue({ toastSuccess: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ changeKeyring: vi.fn(), getCurrentAccount: vi.fn() } as any);
  });

  function renderScreen(keyringType: KeyringType) {
    const accounts = [0, 1, 2].map((i) => ({
      address: `bc1qaccount${i}`,
      alianName: `Account ${i + 1}`,
      flag: 0,
      index: i,
      key: `keyring_0#${i}`,
      pubkey: `account-pubkey-${i}`,
      type: keyringType
    }));
    const keyring = {
      accountIndexDerivation: false,
      accounts,
      addressType: 0,
      alianName: 'Wallet 1',
      hdPath: `m/84'/0'/0'/0`,
      index: 0,
      key: 'keyring_0',
      type: keyringType
    };
    const navigation = { navigate: vi.fn() };

    vi.mocked(useCurrentAccount).mockReturnValue(accounts[1] as any);
    vi.mocked(useCurrentKeyring).mockReturnValue(keyring as any);
    vi.mocked(useNavigation).mockReturnValue(navigation as any);
    render(<SwitchAccountScreen />);

    return { accounts, navigation };
  }

  it('renders one card per account with no filler rows', () => {
    const { accounts } = renderScreen(KeyringType.HdKeyring);

    for (const account of accounts) {
      expect(screen.getByTestId(`account-item-${account.address}`)).toBeTruthy();
    }
  });

  it('creates an account from the bottom CTA and keeps the header shortcut', () => {
    const { navigation } = renderScreen(KeyringType.HdKeyring);

    expect(screen.getByTestId('add-account-button')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-account-button'));

    expect(navigation.navigate).toHaveBeenCalledWith('CreateAccountScreen', {});
  });

  it('hides account creation for keyrings that cannot derive accounts', () => {
    renderScreen(KeyringType.SimpleKeyring);

    expect(screen.queryByTestId('new-account-button')).toBeNull();
    expect(screen.queryByTestId('add-account-button')).toBeNull();
  });
});
