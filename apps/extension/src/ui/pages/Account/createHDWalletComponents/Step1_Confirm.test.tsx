import type { ChangeEventHandler, CSSProperties, KeyboardEventHandler, MouseEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Step1_Confirm } from './Step1_Confirm';
import { TabType, type ContextData } from './types';

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
    onChange,
    onKeyUp,
    'data-testid': dataTestId
  }: {
    autoFocus?: boolean;
    containerStyle?: CSSProperties;
    value?: string;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    onKeyUp?: KeyboardEventHandler<HTMLInputElement>;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'div',
      { style: containerStyle, 'data-testid': `${dataTestId}-input-container` },
      React.createElement('input', { autoFocus, value, onChange, onKeyUp, 'data-testid': dataTestId })
    );
  const Text = ({ text }: { text?: string | number }) => React.createElement('span', null, text);

  return {
    Button,
    Card: Container,
    Column: Container,
    Input,
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
  useI18n: () => ({ t: (key: string) => key })
}));

describe('Step1_Confirm', () => {
  const contextData = {
    mnemonics: 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
  } as ContextData;

  afterEach(() => {
    cleanup();
  });

  it('focuses the first recovery-word input when the step mounts', () => {
    render(<Step1_Confirm contextData={contextData} updateContextData={() => undefined} />);

    expect(document.activeElement).toBe(screen.getByTestId('mnemonic-confirm-word-2'));
  });

  it('renders each word number inside the outer container and removes the nested input border', () => {
    render(<Step1_Confirm contextData={contextData} updateContextData={() => undefined} />);

    const thirdWordContainer = screen.getByTestId('mnemonic-confirm-word-container-2');
    const eighthWordContainer = screen.getByTestId('mnemonic-confirm-word-container-7');
    expect(thirdWordContainer.style.paddingLeft).toBe('4px');
    expect(eighthWordContainer.style.paddingLeft).toBe('4px');
    expect(within(thirdWordContainer).getByText('3.')).toBeTruthy();
    expect(within(eighthWordContainer).getByText('8.')).toBeTruthy();
    expect(screen.getByTestId('mnemonic-confirm-word-2-input-container').style.borderStyle).toBe('none');
    expect(screen.getByTestId('mnemonic-confirm-word-2-input-container').style.boxShadow).toBe('none');
    expect(screen.getByTestId('mnemonic-confirm-word-7-input-container').style.borderStyle).toBe('none');
    expect(screen.getByTestId('mnemonic-confirm-word-7-input-container').style.boxShadow).toBe('none');
  });

  it('focuses the nested input when its outer container is clicked', () => {
    render(<Step1_Confirm contextData={contextData} updateContextData={() => undefined} />);

    fireEvent.click(screen.getByTestId('mnemonic-confirm-word-container-7'));

    expect(document.activeElement).toBe(screen.getByTestId('mnemonic-confirm-word-7'));
  });

  it('continues on Enter once both requested words are verified', () => {
    const updateContextData = vi.fn();
    render(<Step1_Confirm contextData={contextData} updateContextData={updateContextData} />);

    const thirdWordInput = screen.getByTestId('mnemonic-confirm-word-2');
    const eighthWordInput = screen.getByTestId('mnemonic-confirm-word-7');
    fireEvent.change(thirdWordInput, { target: { value: 'decorate' } });
    fireEvent.keyUp(thirdWordInput, { key: 'Enter' });
    expect(updateContextData).not.toHaveBeenCalled();

    fireEvent.change(eighthWordInput, { target: { value: 'desk' } });
    fireEvent.keyUp(eighthWordInput, { key: 'Enter' });

    expect(updateContextData).toHaveBeenCalledTimes(1);
    expect(updateContextData).toHaveBeenCalledWith({
      step1CreateWordsCompleted: true,
      tabType: TabType.CHOOSE_ADDRESS_TYPE
    });
  });
});
