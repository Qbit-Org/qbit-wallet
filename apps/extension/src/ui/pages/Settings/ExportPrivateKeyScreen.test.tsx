import type { ChangeEventHandler, KeyboardEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useExportPrivateKeyScreenLogic } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import ExportPrivateKeyScreen from './ExportPrivateKeyScreen';

// The props the screen gives its password field.
const field = vi.hoisted(() => ({ props: {} as { onKeyDown?: unknown; onKeyUp?: unknown } }));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    React.createElement('div', { onClick }, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
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
  const Header = ({ title }: { title?: string }) => React.createElement('h1', null, title);
  const Icon = () => null;

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Icon,
    Input,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useExportPrivateKeyScreenLogic: vi.fn()
}));

type Logic = ReturnType<typeof useExportPrivateKeyScreenLogic>;

function showPasswordStep() {
  const logic: Logic = {
    t: (key: string) => key,
    setPassword: vi.fn(),
    disabled: true,
    btnClick: vi.fn(),
    handleOnKeyDown: vi.fn(),
    privateKey: { hex: '', wif: '' },
    error: '',
    copy: vi.fn(),
    onClickBack: vi.fn()
  };
  vi.mocked(useExportPrivateKeyScreenLogic).mockReturnValue(logic);
  render(<ExportPrivateKeyScreen />);
  return { logic, input: screen.getByTestId('password-input') };
}

describe('ExportPrivateKeyScreen password field', () => {
  afterEach(() => {
    cleanup();
  });

  it('submits nothing on a keyup in the field', () => {
    // The account switcher's menu acts on the keydown of an Enter; the field
    // has focus by the time that key comes up.
    const { logic, input } = showPasswordStep();

    expect(field.props.onKeyUp).toBeUndefined();
    fireEvent.keyUp(input, { key: 'Enter' });
    expect(logic.btnClick).not.toHaveBeenCalled();
    expect(logic.handleOnKeyDown).not.toHaveBeenCalled();
  });

  it('hands a key pressed in the field to the screen logic', () => {
    const { logic, input } = showPasswordStep();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(logic.handleOnKeyDown).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logic.handleOnKeyDown).mock.calls[0][0].key).toBe('Enter');
  });
});
