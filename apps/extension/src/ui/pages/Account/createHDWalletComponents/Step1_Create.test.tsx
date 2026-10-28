import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WordsType } from '@qbit/wallet-shared';
import { useI18n, useWallet } from '@qbit/wallet-state';

import { Step1_Create } from './Step1_Create';
import type { ContextData, UpdateContextDataParams } from './types';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    'data-testid'?: string;
  }) => React.createElement('div', { style, 'data-testid': dataTestId }, children);
  const Button = ({
    text,
    onClick,
    disabled,
    'data-testid': dataTestId
  }: {
    text?: string;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      { onClick: disabled ? undefined : onClick, disabled, 'data-testid': dataTestId },
      text
    );
  const Checkbox = ({
    checked,
    disabled,
    onChange,
    'data-testid': dataTestId
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
    'data-testid'?: string;
  }) =>
    React.createElement('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        onChange?.({ target: { checked: event.target.checked } });
      },
      'data-testid': dataTestId
    });
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);

  return {
    Button,
    Card: Container,
    Checkbox,
    Column: Container,
    Grid: Container,
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
  useI18n: vi.fn(),
  useWallet: vi.fn()
}));

const WORDS_12 = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
const WORDS_24 =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray';

function createContext(wordsType: WordsType, mnemonics: string): ContextData {
  return {
    mnemonics,
    wordsType
  } as ContextData;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function StatefulStep1({ initialContext }: { initialContext: ContextData }) {
  const [contextData, setContextData] = useState(initialContext);
  const updateContextData = (params: UpdateContextDataParams) => {
    setContextData((current) => ({ ...current, ...params }));
  };

  return <Step1_Create contextData={contextData} updateContextData={updateContextData} />;
}

describe('Step1_Create mnemonic generation lifecycle', () => {
  const generatePreMnemonic = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as unknown as ReturnType<typeof useI18n>);
    vi.mocked(useWallet).mockReturnValue({
      generatePreMnemonic
    } as unknown as ReturnType<typeof useWallet>);
  });

  afterEach(() => {
    cleanup();
  });

  it('generates and renders 24 words for the 256-bit selection', async () => {
    generatePreMnemonic.mockResolvedValue(WORDS_24);

    render(<StatefulStep1 initialContext={createContext(WordsType.WORDS_24, '')} />);

    expect(generatePreMnemonic).toHaveBeenCalledWith(256);
    await screen.findByTestId('mnemonic-word-23');
    expect(screen.getAllByTestId(/^mnemonic-word-/)).toHaveLength(24);
  });

  it('ignores a stale generation after the selected word count changes back', async () => {
    const pending = deferred<string>();
    generatePreMnemonic.mockReturnValue(pending.promise);
    const updateContextData = vi.fn();
    const view = render(
      <Step1_Create contextData={createContext(WordsType.WORDS_12, WORDS_12)} updateContextData={updateContextData} />
    );

    expect(generatePreMnemonic).not.toHaveBeenCalled();
    const checkbox = screen.getByTestId('mnemonic-saved-checkbox') as HTMLInputElement;
    const continueButton = screen.getByTestId('mnemonic-continue-button') as HTMLButtonElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(continueButton.disabled).toBe(false);
    updateContextData.mockClear();

    view.rerender(
      <Step1_Create contextData={createContext(WordsType.WORDS_24, WORDS_12)} updateContextData={updateContextData} />
    );
    expect(generatePreMnemonic).toHaveBeenCalledTimes(1);
    expect(generatePreMnemonic).toHaveBeenCalledWith(256);
    expect(checkbox.disabled).toBe(true);
    expect(continueButton.disabled).toBe(true);

    view.rerender(
      <Step1_Create contextData={createContext(WordsType.WORDS_12, WORDS_12)} updateContextData={updateContextData} />
    );

    await act(async () => {
      pending.resolve(WORDS_24);
      await pending.promise;
    });

    expect(updateContextData).not.toHaveBeenCalled();
  });

  it('ignores a generation that completes after unmount', async () => {
    const pending = deferred<string>();
    generatePreMnemonic.mockReturnValue(pending.promise);
    const updateContextData = vi.fn();
    const view = render(
      <Step1_Create contextData={createContext(WordsType.WORDS_24, WORDS_12)} updateContextData={updateContextData} />
    );

    expect(generatePreMnemonic).toHaveBeenCalledWith(256);
    view.unmount();

    await act(async () => {
      pending.resolve(WORDS_24);
      await pending.promise;
    });

    expect(updateContextData).not.toHaveBeenCalled();
  });

  it('disables acknowledgement and continuation until the initial phrase is ready', async () => {
    const pending = deferred<string>();
    generatePreMnemonic.mockReturnValue(pending.promise);
    render(<StatefulStep1 initialContext={createContext(WordsType.WORDS_12, '')} />);

    const checkbox = screen.getByTestId('mnemonic-saved-checkbox') as HTMLInputElement;
    const continueButton = screen.getByTestId('mnemonic-continue-button') as HTMLButtonElement;

    expect(checkbox.disabled).toBe(true);
    expect(continueButton.disabled).toBe(true);

    await act(async () => {
      pending.resolve(WORDS_12);
      await pending.promise;
    });

    await screen.findByTestId('mnemonic-word-11');
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(continueButton.disabled).toBe(false);
  });
});
