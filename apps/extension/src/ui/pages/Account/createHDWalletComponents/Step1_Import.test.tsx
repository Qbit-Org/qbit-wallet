import type {
  ChangeEventHandler,
  CSSProperties,
  FocusEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useCreateWalletLogicImportWordsStep } from '@qbit/wallet-state';

import { Step1_Import } from './Step1_Import';
import type { ContextData } from './types';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    style,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLDivElement>;
    style?: CSSProperties;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, style, 'data-testid': dataTestId }, children);
  const Button = ({
    disabled,
    onClick,
    text,
    'data-testid': dataTestId
  }: {
    disabled?: boolean;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    text?: string;
    'data-testid'?: string;
  }) => React.createElement('button', { disabled, onClick, 'data-testid': dataTestId }, text);
  const Input = ({
    autoFocus,
    containerStyle,
    value,
    onBlur,
    onChange,
    onFocus,
    onKeyUp,
    'data-testid': dataTestId
  }: {
    autoFocus?: boolean;
    containerStyle?: CSSProperties;
    value?: string;
    onBlur?: FocusEventHandler<HTMLInputElement>;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    onFocus?: FocusEventHandler<HTMLInputElement>;
    onKeyUp?: KeyboardEventHandler<HTMLInputElement>;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'div',
      { style: containerStyle, 'data-testid': `${dataTestId}-input-container` },
      React.createElement('input', {
        autoFocus,
        value,
        onBlur,
        onChange,
        onFocus,
        onKeyUp,
        'data-testid': dataTestId
      })
    );
  const Text = ({ text }: { text?: string | number }) => React.createElement('span', null, text);

  return {
    Button,
    Card: Container,
    Column: Container,
    Grid: Container,
    Input,
    Radio: Container,
    RadioGroup: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/FooterButtonContainer', async () => {
  const React = await import('react');
  return {
    FooterButtonContainer: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children)
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useCreateWalletLogicImportWordsStep: vi.fn()
}));

describe('Step1_Import', () => {
  const onClickNext = vi.fn();

  beforeEach(() => {
    vi.mocked(useCreateWalletLogicImportWordsStep).mockReturnValue({
      wordsItems: [],
      t: (key: string) => key,
      onHandleEventPaste: vi.fn(),
      inputWords: ['', ''],
      inputWordsInvalid: [false, false],
      inputWordsError: false,
      pastedTooManyWords: false,
      onClickNext,
      onClickWordsItem: vi.fn(),
      onInputWordsChange: vi.fn(),
      disabled: false
    } as unknown as ReturnType<typeof useCreateWalletLogicImportWordsStep>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderStep = () => render(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);

  it('keeps each word number inside the outer container and removes the nested input border', () => {
    renderStep();

    const firstWordContainer = screen.getByTestId('mnemonic-import-word-container-0');
    const secondWordContainer = screen.getByTestId('mnemonic-import-word-container-1');
    expect(firstWordContainer.style.paddingLeft).toBe('4px');
    expect(secondWordContainer.style.paddingLeft).toBe('4px');
    expect(within(firstWordContainer).getByText('1.')).toBeTruthy();
    expect(within(secondWordContainer).getByText('2.')).toBeTruthy();
    expect(screen.getByTestId('mnemonic-import-word-0-input-container').style.borderStyle).toBe('none');
    expect(screen.getByTestId('mnemonic-import-word-0-input-container').style.boxShadow).toBe('none');
    expect(screen.getByTestId('mnemonic-import-word-1-input-container').style.borderStyle).toBe('none');
    expect(screen.getByTestId('mnemonic-import-word-1-input-container').style.boxShadow).toBe('none');
  });

  it('focuses the nested input when its outer container is clicked', () => {
    renderStep();

    fireEvent.click(screen.getByTestId('mnemonic-import-word-container-1'));

    expect(document.activeElement).toBe(screen.getByTestId('mnemonic-import-word-1'));
  });

  it('preserves Enter-to-continue behavior', () => {
    renderStep();

    fireEvent.keyUp(screen.getByTestId('mnemonic-import-word-1'), { key: 'Enter' });

    expect(onClickNext).toHaveBeenCalledTimes(1);
  });
});
