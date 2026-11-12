import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WalletKeyring } from '@qbit/wallet-shared';
import { KeyringType, MAX_ALIAS_NAME_LENGTH } from '@qbit/wallet-shared';

import { NameEditDialog, NewAccountDialog } from './SwitcherDialogs';

const harness = vi.hoisted(() => ({
  wallet: {} as Record<string, ReturnType<typeof vi.fn>>
}));

vi.mock('@qbit/wallet-state', async () => {
  // The package's own rule for an Enter pressed in a field. The package index
  // needs import paths only the package's own setup resolves, so the module
  // that holds the rule is imported alone.
  const { isEnterPressedInField } = await import(
    '../../../../../../packages/wallet-state/src/ui-hooks/isEnterPressedInField'
  );
  return {
    isEnterPressedInField,
    useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
    useTools: () => ({ toastError: vi.fn() }),
    useWallet: () => harness.wallet
  };
});

// The real Input pulls in the whole component library, which needs the
// extension's browser APIs; a plain input with the same props stands in.
vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({ preset: _preset, ...props }: { preset?: string } & Record<string, unknown>) =>
      React.createElement('input', props)
  };
});

const keyring = {
  key: 'keyring_2',
  index: 2,
  type: KeyringType.QbitHdKeyring,
  addressType: 9,
  accounts: [],
  alianName: 'Long-term savings',
  color: 'pink',
  hdPath: ''
} as unknown as WalletKeyring;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let onCreate: ReturnType<typeof vi.fn>;
let onDismiss: ReturnType<typeof vi.fn>;

beforeEach(() => {
  harness.wallet = { getNextAlianName: vi.fn(async () => 'Account 4') };
  // The switcher's derive: it settles later, and never rejects.
  onCreate = vi.fn(() => new Promise<void>(() => undefined));
  onDismiss = vi.fn();
});

afterEach(() => {
  cleanup();
});

async function renderDialog() {
  render(<NewAccountDialog keyring={keyring} onCreate={onCreate} onDismiss={onDismiss} />);
  // Let the suggested name arrive.
  await act(async () => {
    await Promise.resolve();
  });
}

const dialog = () => screen.getByTestId('new-account-dialog');
const nameField = () => screen.getByTestId('create-account-name-input') as HTMLInputElement;
const createButton = () => screen.getByTestId('create-account-confirm-button');
const cancelButton = () => screen.getByTestId('create-account-cancel-button');
const closeButton = () => screen.getByTestId('create-account-close-button');

/** One press of Enter in `element`, as a key goes down and comes up. */
function pressEnter(element: HTMLElement) {
  fireEvent.keyDown(element, { key: 'Enter' });
  fireEvent.keyUp(element, { key: 'Enter' });
}

describe('NewAccountDialog layout', () => {
  it('names the wallet the account goes to, with its tile, above the focused name field', async () => {
    await renderDialog();

    expect(screen.getByRole('dialog', { name: 'new_account' })).toBe(dialog());
    const walletName = screen.getByTestId('create-account-wallet-name');
    expect(walletName.textContent).toBe('Long-term savings');
    expect(walletName.getAttribute('title')).toBe('Long-term savings');
    expect(screen.getByTestId('create-account-wallet-tile').getAttribute('data-color')).toBe('pink');
    expect(walletName.compareDocumentPosition(nameField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(nameField());
    // The field takes focus first, so it carries the wallet's name too.
    expect(nameField().getAttribute('aria-describedby')).toBe(walletName.id);
    // The wrapper that draws its focus cue, as for the rename dialog's field.
    expect(nameField().closest('.switcher-dialog__field')).not.toBeNull();
    expect(nameField().maxLength).toBe(MAX_ALIAS_NAME_LENGTH);
    expect(closeButton().tagName).toBe('BUTTON');
    expect(closeButton().getAttribute('aria-label')).toBe('close');
    expect(cancelButton().textContent).toBe('cancel');
    expect(createButton().textContent).toBe('create');
  });

  it('suggests the name the background would give an account of that wallet', async () => {
    await renderDialog();

    expect(harness.wallet.getNextAlianName).toHaveBeenCalledTimes(1);
    expect(harness.wallet.getNextAlianName).toHaveBeenCalledWith(keyring);
    expect(nameField().placeholder).toBe('Account 4');
  });

  it('reads the suggestion again when the wallet changes, and drops an answer a newer read overtook', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    harness.wallet.getNextAlianName.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<NewAccountDialog keyring={keyring} onCreate={onCreate} onDismiss={onDismiss} />);
    // The sheet's copy of the wallet changes: another window added an account.
    const grown = { ...keyring, accounts: [{ key: 'keyring_2#0' }] } as unknown as WalletKeyring;
    rerender(<NewAccountDialog keyring={grown} onCreate={onCreate} onDismiss={onDismiss} />);
    expect(harness.wallet.getNextAlianName).toHaveBeenNthCalledWith(2, grown);

    await act(async () => second.resolve('Account 5'));
    expect(nameField().placeholder).toBe('Account 5');
    // The answer to the read made for the wallet as it was comes last.
    await act(async () => first.resolve('Account 4'));
    expect(nameField().placeholder).toBe('Account 5');
  });

  it('reads no suggestion once the account is being created', async () => {
    const { rerender } = render(<NewAccountDialog keyring={keyring} onCreate={onCreate} onDismiss={onDismiss} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(createButton());

    // The account just derived reaches the sheet's copy of the wallet.
    const grown = { ...keyring, accounts: [{ key: 'keyring_2#0' }] } as unknown as WalletKeyring;
    rerender(<NewAccountDialog keyring={grown} onCreate={onCreate} onDismiss={onDismiss} />);

    expect(harness.wallet.getNextAlianName).toHaveBeenCalledTimes(1);
  });

  it('suggests nothing when the suggestion cannot be read, and still creates', async () => {
    harness.wallet.getNextAlianName.mockRejectedValueOnce({ message: 'port closed' });
    await renderDialog();

    expect(nameField().placeholder).toBe('');
    fireEvent.click(createButton());
    // The background names the account itself.
    expect(onCreate).toHaveBeenCalledWith(undefined);
  });
});

describe('NewAccountDialog creating', () => {
  it('sends no name when none is typed, so the background names the account as it derives it', async () => {
    await renderDialog();

    fireEvent.click(createButton());

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(undefined);
  });

  it('sends the typed name trimmed', async () => {
    await renderDialog();

    fireEvent.change(nameField(), { target: { value: ' Travel ' } });
    fireEvent.click(createButton());

    expect(onCreate).toHaveBeenCalledWith('Travel');
  });

  it('sends no name for a name of spaces only', async () => {
    await renderDialog();

    fireEvent.change(nameField(), { target: { value: '   ' } });
    fireEvent.click(createButton());

    expect(onCreate).toHaveBeenCalledWith(undefined);
  });

  it('asks for one account however often Create is clicked, and shows it is busy', async () => {
    await renderDialog();

    fireEvent.click(createButton());
    fireEvent.click(createButton());
    fireEvent.keyDown(createButton(), { key: 'Enter' });
    fireEvent.click(createButton());

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    expect(createButton().querySelector('.icon-spin')).not.toBeNull();
    expect(nameField().readOnly).toBe(true);
    expect(dialog().getAttribute('aria-busy')).toBe('true');
  });

  it('creates on an Enter pressed in the name field, once while it is created', async () => {
    await renderDialog();

    fireEvent.change(nameField(), { target: { value: 'Travel' } });
    pressEnter(nameField());
    pressEnter(nameField());

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Travel');
  });

  it('creates nothing when the Enter that opened the dialog comes up in the name field', async () => {
    // The switcher's "+" and Add Account act on the keydown of an Enter; the
    // field has focus by the time that key comes up.
    await renderDialog();

    fireEvent.keyUp(nameField(), { key: 'Enter' });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('creates nothing while an Enter held down since before the dialog opened repeats', async () => {
    await renderDialog();

    for (let repeat = 0; repeat < 3; repeat++) {
      fireEvent.keyDown(nameField(), { key: 'Enter', repeat: true });
    }
    fireEvent.keyUp(nameField(), { key: 'Enter' });

    expect(onCreate).not.toHaveBeenCalled();
    expect(dialog().getAttribute('aria-busy')).toBeNull();
  });

  it('creates one account for an Enter held down in the name field', async () => {
    await renderDialog();

    fireEvent.keyDown(nameField(), { key: 'Enter' });
    for (let repeat = 0; repeat < 3; repeat++) {
      fireEvent.keyDown(nameField(), { key: 'Enter', repeat: true });
    }
    fireEvent.keyUp(nameField(), { key: 'Enter' });

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on the Enter that ends a composition, only on the next press', async () => {
    await renderDialog();

    // An input method takes this Enter to commit the typed text.
    fireEvent.keyDown(nameField(), { key: 'Enter', isComposing: true });
    fireEvent.keyUp(nameField(), { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();

    pressEnter(nameField());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on an Enter pressed anywhere but the name field', async () => {
    await renderDialog();

    pressEnter(screen.getByTestId('create-account-wallet-name'));
    pressEnter(screen.getByTestId('create-account-wallet-tile'));
    pressEnter(dialog());

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('never offers Create again once the derive was asked for, though it settled', async () => {
    const derive = deferred<void>();
    onCreate.mockReturnValueOnce(derive.promise);
    await renderDialog();

    fireEvent.click(createButton());
    // The switcher closes the dialog once the derive settles; until then a
    // second Create could derive a second account.
    await act(async () => derive.resolve());
    fireEvent.click(createButton());
    pressEnter(nameField());

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
  });
});

describe('NameEditDialog keyboard', () => {
  it('keeps Tab in the dialog from Save while it saves, though Save has left the tab order', async () => {
    const save = deferred<void>();
    render(<NameEditDialog title="Rename" initialName="Wallet 1" onSave={() => save.promise} onDismiss={vi.fn()} />);
    fireEvent.change(screen.getByTestId('name-edit-input'), { target: { value: 'Travel' } });
    const saveButton = screen.getByTestId('name-edit-save');
    // A click focuses the button it lands on.
    saveButton.focus();
    fireEvent.click(saveButton);
    expect(saveButton.getAttribute('aria-disabled')).toBe('true');
    expect(saveButton.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(saveButton);

    fireEvent.keyDown(saveButton, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('name-edit-input'));

    saveButton.focus();
    fireEvent.keyDown(saveButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('name-edit-cancel'));
    await act(async () => save.resolve());
  });
});

describe('NewAccountDialog dismissing', () => {
  it.each([
    ['Cancel', () => fireEvent.click(cancelButton())],
    ['Enter on Cancel', () => fireEvent.keyDown(cancelButton(), { key: 'Enter' })],
    ['the close button', () => fireEvent.click(closeButton())],
    ['Escape', () => fireEvent.keyDown(nameField(), { key: 'Escape' })]
  ])('returns to the sheet with %s before Create', async (_way, dismiss) => {
    await renderDialog();

    dismiss();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while the account is created', async () => {
    await renderDialog();

    fireEvent.click(createButton());
    fireEvent.click(cancelButton());
    fireEvent.keyDown(cancelButton(), { key: 'Enter' });
    fireEvent.click(closeButton());
    fireEvent.keyDown(nameField(), { key: 'Escape' });

    expect(onDismiss).not.toHaveBeenCalled();
    for (const control of [cancelButton(), closeButton()]) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.tabIndex).toBe(-1);
    }
  });

  it('keeps Tab inside the dialog', async () => {
    await renderDialog();

    createButton().focus();
    fireEvent.keyDown(createButton(), { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton());
    fireEvent.keyDown(closeButton(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(createButton());
  });

  it.each([
    ['a click', () => fireEvent.click(createButton())],
    ['Enter', () => fireEvent.keyDown(createButton(), { key: 'Enter' })]
  ])(
    'moves focus from the Create button to the name field on %s, and keeps Tab there while busy',
    async (_way, press) => {
      await renderDialog();
      // A click focuses the button it lands on, as a key press needs it focused.
      createButton().focus();

      press();

      expect(onCreate).toHaveBeenCalledTimes(1);
      // The busy Create button is out of the tab order; the read-only field is not.
      expect(createButton().tabIndex).toBe(-1);
      expect(document.activeElement).toBe(nameField());
      expect(nameField().readOnly).toBe(true);
      fireEvent.keyDown(nameField(), { key: 'Tab' });
      expect(document.activeElement).toBe(nameField());
      fireEvent.keyDown(nameField(), { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(nameField());
    }
  );
});
