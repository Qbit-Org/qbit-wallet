import type { ChangeEventHandler, KeyboardEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyringType, type Account, type WalletKeyring } from '@qbit/wallet-shared';
import { useExportMnemonicsScreenLogic } from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import ExportMnemonicsScreen from './ExportMnemonicsScreen';

// The props the screen gives its password field.
const field = vi.hoisted(() => ({ props: {} as { onKeyDown?: unknown; onKeyUp?: unknown } }));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    React.createElement('div', { onClick }, children);
  const Text = ({ text, onClick }: { text?: string; onClick?: () => void }) =>
    React.createElement('span', { onClick }, text);
  const Button = ({ text, onClick, disabled }: { text?: string; onClick?: () => void; disabled?: boolean }) =>
    React.createElement('button', { onClick, disabled }, text);
  const Input = (props: {
    onChange?: ChangeEventHandler<HTMLInputElement>;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    onKeyUp?: KeyboardEventHandler<HTMLInputElement>;
  }) => {
    field.props = props;
    const { onChange, onKeyDown, onKeyUp } = props;
    return React.createElement('input', { onChange, onKeyDown, onKeyUp, 'data-testid': 'password-input' });
  };
  const TextArea = ({ text }: { text?: string }) => React.createElement('textarea', { value: text, readOnly: true });
  const Header = ({ title }: { title?: string }) => React.createElement('h1', null, title);
  const Icon = () => null;

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Grid: Container,
    Header,
    Icon,
    Input,
    Layout: Container,
    Row: Container,
    Text,
    TextArea
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useExportMnemonicsScreenLogic: vi.fn()
}));

type Logic = ReturnType<typeof useExportMnemonicsScreenLogic>;

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Paths as the background returns them, with an apostrophe for each hardened step.
const NATIVE_SEGWIT_PATH = String.raw`m/84'/0'/0'/0`;
const CUSTOM_PATH = String.raw`m/44'/0'/1'/0`;
const QBIT_PATH = String.raw`m/87'/0'/0'/0`;

function listedWallet(type: string, addressType: AddressType, hdPath: string, accounts: Account[] = []): WalletKeyring {
  return {
    key: 'keyring_0',
    index: 0,
    type,
    addressType,
    accounts,
    alianName: 'Wallet 1',
    color: 'green',
    hdPath
  };
}

const descriptors: NonNullable<Logic['p2mrDescriptors']> = {
  network: 'mainnet',
  coinType: 0,
  containsPrivateKeys: true,
  external: {
    branch: 'external',
    change: 0,
    path: 'm/87h/0h/0h/0/*',
    descriptor: 'mr(pk(pqc(receive-key/87h/0h/0h/0/*)))#receive0',
    descriptorNoChecksum: 'mr(pk(pqc(receive-key/87h/0h/0h/0/*)))'
  },
  internal: {
    branch: 'internal',
    change: 1,
    path: 'm/87h/0h/0h/1/*',
    descriptor: 'mr(pk(pqc(change-key/87h/0h/0h/1/*)))#change00',
    descriptorNoChecksum: 'mr(pk(pqc(change-key/87h/0h/0h/1/*)))'
  },
  hkdf: { account: 0, change: 0 },
  coreProvenance: { repository: 'Qbit-Org/qbit', commit: 'abc123', source: 'src/wallet/walletutil.cpp' }
};

const copy = vi.fn();

function showPhrase(overrides: Partial<Logic>) {
  // No descriptors unless a test gives them, as for a wallet that is not P2MR.
  // The declared type has no undefined for them: wallet-state builds without
  // strictNullChecks.
  vi.mocked(useExportMnemonicsScreenLogic).mockReturnValue({
    words: PHRASE.split(' '),
    pathName: 'custom',
    t: (key: string) => key,
    setPassword: vi.fn(),
    disabled: false,
    btnClick: vi.fn(),
    handleOnKeyDown: vi.fn(),
    mnemonic: PHRASE,
    passphrase: '',
    importDescriptorsJson: '',
    isP2mrKeyring: false,
    error: '',
    copy,
    keyring: listedWallet(KeyringType.HdKeyring, AddressType.P2WPKH, ''),
    hdPath: '',
    onClickBack: vi.fn(),
    ...overrides
  } as Logic);
  render(<ExportMnemonicsScreen />);
}

function derivationPathLines(): HTMLElement[] {
  return screen.queryAllByText((content) => content.startsWith('derivation_path'));
}

describe('ExportMnemonicsScreen derivation path', () => {
  beforeEach(() => {
    copy.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows and copies the path of a healthy wallet as before', () => {
    showPhrase({
      keyring: listedWallet(KeyringType.HdKeyring, AddressType.P2WPKH, NATIVE_SEGWIT_PATH, [
        { type: KeyringType.HdKeyring, pubkey: '02ab', address: 'qb1zexample', key: 'keyring_0#0', flag: 0 }
      ]),
      hdPath: NATIVE_SEGWIT_PATH,
      pathName: 'Native Segwit (P2WPKH)'
    });

    const line = screen.getByText(`derivation_path: ${NATIVE_SEGWIT_PATH}/0 (Native Segwit (P2WPKH))`);
    fireEvent.click(line);

    expect(copy).toHaveBeenCalledWith(NATIVE_SEGWIT_PATH);
  });

  it('shows and copies the real path of a corrupted HD Key Tree wallet, not the empty listed one', () => {
    showPhrase({
      keyring: listedWallet(KeyringType.HdKeyring, AddressType.P2WPKH, ''),
      hdPath: CUSTOM_PATH,
      pathName: 'custom',
      passphrase: 'extra word'
    });

    expect(derivationPathLines().map((line) => line.textContent)).toEqual([
      `derivation_path: ${CUSTOM_PATH}/0 (custom)`
    ]);
    fireEvent.click(screen.getByText(`derivation_path: ${CUSTOM_PATH}/0 (custom)`));

    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(CUSTOM_PATH);
    expect(screen.getByText('passphrase: extra word')).toBeTruthy();
  });

  it('shows and copies the real path and the descriptors of a corrupted Qbit HD wallet', () => {
    showPhrase({
      keyring: listedWallet(KeyringType.QbitHdKeyring, AddressType.P2MR, ''),
      hdPath: QBIT_PATH,
      pathName: 'Post-Quantum P2MR',
      isP2mrKeyring: true,
      p2mrDescriptors: descriptors,
      importDescriptorsJson: '[{"desc":"descriptors"}]'
    });

    expect(derivationPathLines().map((line) => line.textContent)).toEqual([
      `derivation_path: ${QBIT_PATH}/0 (Post-Quantum P2MR)`
    ]);
    fireEvent.click(screen.getByText(`derivation_path: ${QBIT_PATH}/0 (Post-Quantum P2MR)`));
    expect(copy).toHaveBeenLastCalledWith(QBIT_PATH);

    fireEvent.click(screen.getByText('qbit_core_recovery_descriptors'));
    fireEvent.click(screen.getByText('qbit_core_copy_receive_descriptor'));
    expect(copy).toHaveBeenLastCalledWith(descriptors.external.descriptor);
    fireEvent.click(screen.getByText('qbit_core_copy_change_descriptor'));
    expect(copy).toHaveBeenLastCalledWith(descriptors.internal.descriptor);

    fireEvent.click(screen.getByText('qbit_core_importdescriptors_json'));
    fireEvent.click(screen.getByText('qbit_core_copy_json'));
    expect(copy).toHaveBeenLastCalledWith('[{"desc":"descriptors"}]');
  });

  it('leaves the path out when the background returns none', () => {
    showPhrase({
      keyring: listedWallet(KeyringType.HdKeyring, AddressType.P2WPKH, ''),
      hdPath: '',
      passphrase: 'extra word'
    });

    expect(derivationPathLines()).toEqual([]);
    expect(screen.queryByText(/\/0 \(custom\)/)).toBeNull();
    expect(screen.getByText('passphrase: extra word')).toBeTruthy();
    expect(screen.getAllByText('abandon')).toHaveLength(11);
  });

  it('shows a refusal on the password step, with no phrase', () => {
    showPhrase({
      words: [''],
      mnemonic: '',
      error: 'The selected wallet is no longer available'
    });

    expect(screen.getByText('The selected wallet is no longer available')).toBeTruthy();
    expect(screen.getByText('show_secret_recovery_phrase')).toBeTruthy();
    expect(screen.queryByText('this_phrase_is_the_only_way_to_recover_your_wallet')).toBeNull();
    expect(derivationPathLines()).toEqual([]);
  });
});

describe('ExportMnemonicsScreen password field', () => {
  afterEach(() => {
    cleanup();
  });

  function showPasswordStep() {
    const btnClick = vi.fn();
    const handleOnKeyDown = vi.fn();
    showPhrase({ words: [''], mnemonic: '', disabled: true, btnClick, handleOnKeyDown });
    return { btnClick, handleOnKeyDown, input: screen.getByTestId('password-input') };
  }

  it('submits nothing on a keyup in the field', () => {
    // The wallet menu acts on the keydown of an Enter; the field has focus by
    // the time that key comes up.
    const { btnClick, handleOnKeyDown, input } = showPasswordStep();

    expect(field.props.onKeyUp).toBeUndefined();
    fireEvent.keyUp(input, { key: 'Enter' });
    expect(btnClick).not.toHaveBeenCalled();
    expect(handleOnKeyDown).not.toHaveBeenCalled();
  });

  it('hands a key pressed in the field to the screen logic', () => {
    const { handleOnKeyDown, input } = showPasswordStep();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(handleOnKeyDown).toHaveBeenCalledTimes(1);
    expect(handleOnKeyDown.mock.calls[0][0].key).toBe('Enter');
  });
});
