import type { CSSProperties, InputHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCreateWalletLogicImportWordsStep } from '@qbit/wallet-state';

import { Step1_Import } from './Step1_Import';
import type { ContextData } from './types';

// The extension's test setup cannot load the wallet-state hooks (their `src/`
// imports resolve only in that package), so the hook's word checks are tested
// in packages/wallet-state/test/ui-hooks/useCreateWalletLogicImportWordsStep.test.ts.
// Here the real Card renders the border. Input stands in for PasswordInput,
// which passes every other prop to its <input>; the real one cannot be
// imported without the whole component index.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const { Card } = await import('@/ui/components/Card');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
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
    containerStyle,
    preset: _preset,
    ...rest
  }: InputHTMLAttributes<HTMLInputElement> & { containerStyle?: CSSProperties; preset?: string }) =>
    React.createElement('div', { style: containerStyle }, React.createElement('input', { type: 'password', ...rest }));
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string | number; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);

  return {
    Button,
    Card,
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

type HookResult = ReturnType<typeof useCreateWalletLogicImportWordsStep>;

const WORD_COUNT = 12;
const INVALID_PHRASE_MESSAGE = 'mnemonic-import-invalid-phrase';
const TOO_MANY_WORDS_MESSAGE = 'mnemonic-import-too-many-words';

let hookResult: HookResult;

function setHookResult(overrides: Partial<HookResult>) {
  hookResult = { ...hookResult, ...overrides };
  vi.mocked(useCreateWalletLogicImportWordsStep).mockReturnValue(hookResult);
}

const flags = (...flagged: number[]) => Array.from({ length: WORD_COUNT }, (_, index) => flagged.includes(index));

const wordInput = (index: number) => screen.getByTestId(`mnemonic-import-word-${index}`) as HTMLInputElement;
const wordCard = (index: number) => screen.getByTestId(`mnemonic-import-word-container-${index}`);
const continueButton = () => screen.getByTestId('mnemonic-import-continue-button');

function isFlagged(index: number) {
  const input = wordInput(index);
  const flagged = input.getAttribute('data-invalid') === 'true';
  expect(input.getAttribute('aria-invalid')).toBe(String(flagged));
  expect(wordCard(index).style.border).toBe(`1px solid ${flagged ? 'var(--qbit-danger-text)' : 'var(--qbit-line)'}`);
  return flagged;
}

const flaggedInputs = () => Array.from({ length: WORD_COUNT }, (_, index) => index).filter(isFlagged);

describe('Step1_Import word checks', () => {
  beforeEach(() => {
    hookResult = {
      wordsItems: [],
      t: (key: string) => key,
      onHandleEventPaste: vi.fn(),
      inputWords: new Array(WORD_COUNT).fill(''),
      inputWordsInvalid: flags(),
      inputWordsError: false,
      pastedTooManyWords: false,
      onClickNext: vi.fn(),
      onClickWordsItem: vi.fn(),
      onInputWordsChange: vi.fn(),
      disabled: true
    } as unknown as HookResult;
    setHookResult({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderStep = () => render(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);

  it('shows no flag or message while the inputs are empty', () => {
    renderStep();

    expect(flaggedInputs()).toEqual([]);
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
  });

  it('flags a word outside the list after blur, not while it is focused', () => {
    const { rerender } = renderStep();
    fireEvent.focus(wordInput(0));
    setHookResult({ inputWordsInvalid: flags(0) });
    rerender(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);

    expect(flaggedInputs()).toEqual([]);

    fireEvent.blur(wordInput(0));
    expect(flaggedInputs()).toEqual([0]);
  });

  it('clears the flag when the input gets focus again or the word is corrected', () => {
    setHookResult({ inputWordsInvalid: flags(0) });
    const { rerender } = renderStep();
    fireEvent.blur(wordInput(0));
    expect(flaggedInputs()).toEqual([0]);

    fireEvent.focus(wordInput(0));
    expect(flaggedInputs()).toEqual([]);

    fireEvent.blur(wordInput(0));
    expect(flaggedInputs()).toEqual([0]);

    setHookResult({ inputWordsInvalid: flags() });
    rerender(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);
    expect(flaggedInputs()).toEqual([]);
  });

  it('flags a mistyped pasted word even though another input has focus', () => {
    const { rerender } = renderStep();
    fireEvent.focus(wordInput(0));
    fireEvent.paste(wordInput(0));
    expect(hookResult.onHandleEventPaste).toHaveBeenCalledWith(expect.anything(), 0);

    setHookResult({ inputWordsInvalid: flags(5) });
    rerender(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);

    expect(document.activeElement).toBe(wordInput(0));
    expect(flaggedInputs()).toEqual([5]);
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
  });

  it('says why a complete phrase of listed words is not accepted', () => {
    setHookResult({ inputWordsError: true });
    renderStep();

    expect(flaggedInputs()).toEqual([]);
    expect(screen.getByTestId(INVALID_PHRASE_MESSAGE).textContent).toBe('recovery_phrase_is_not_valid');
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds the phrase message back while a word is being typed', () => {
    const { rerender } = renderStep();
    // Stands in for the hook's state update after each keystroke.
    const typeLastWord = (word: string, overrides: Partial<HookResult>) => {
      setHookResult(overrides);
      fireEvent.change(wordInput(11), { target: { value: word } });
      rerender(<Step1_Import contextData={{} as ContextData} updateContextData={() => undefined} />);
    };
    fireEvent.focus(wordInput(11));

    // "act" is in the list, so a full grid fails only the checksum.
    typeLastWord('act', { inputWordsError: true });
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();

    typeLastWord('action', { inputWordsError: false, disabled: false });
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);

    typeLastWord('act', { inputWordsError: true, disabled: true });
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
    fireEvent.blur(wordInput(11));
    expect(screen.getByTestId(INVALID_PHRASE_MESSAGE)).toBeTruthy();
  });

  it('shows the phrase message when Enter is pressed on a phrase that fails the checksum', () => {
    renderStep();
    fireEvent.focus(wordInput(11));
    setHookResult({ inputWordsError: true });
    fireEvent.change(wordInput(11), { target: { value: 'act' } });
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();

    fireEvent.keyUp(wordInput(11), { key: 'Enter' });

    expect(screen.getByTestId(INVALID_PHRASE_MESSAGE)).toBeTruthy();
    expect(hookResult.onClickNext).not.toHaveBeenCalled();
  });

  it('shows the phrase message right after a paste into the input being typed in', () => {
    renderStep();
    fireEvent.focus(wordInput(0));
    fireEvent.change(wordInput(0), { target: { value: 'aban' } });

    setHookResult({ inputWordsError: true });
    fireEvent.paste(wordInput(0));

    expect(document.activeElement).toBe(wordInput(0));
    expect(screen.getByTestId(INVALID_PHRASE_MESSAGE)).toBeTruthy();
  });

  it('asks for the matching phrase length when a paste had more words than inputs', () => {
    setHookResult({ pastedTooManyWords: true, inputWordsError: true });
    renderStep();

    expect(screen.getByTestId(TOO_MANY_WORDS_MESSAGE).textContent).toBe('pasted_phrase_has_too_many_words');
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
  });

  it('shows no flag or message for a valid phrase and enables Continue', () => {
    setHookResult({ disabled: false });
    renderStep();
    fireEvent.blur(wordInput(0));

    expect(flaggedInputs()).toEqual([]);
    expect(screen.queryByTestId(INVALID_PHRASE_MESSAGE)).toBeNull();
    expect(screen.queryByTestId(TOO_MANY_WORDS_MESSAGE)).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(hookResult.onClickNext).toHaveBeenCalledTimes(1);
  });

  it('adds no attribute that holds a word', () => {
    const words = ['zebrax', ...new Array(WORD_COUNT - 1).fill('abandon')];
    setHookResult({ inputWords: words, inputWordsInvalid: flags(0) });
    renderStep();
    fireEvent.blur(wordInput(0));

    expect(flaggedInputs()).toEqual([0]);
    expect(wordInput(0).type).toBe('password');
    // React mirrors a controlled input's value into its value attribute, as it
    // did before this check; every other attribute must stay free of words.
    const attributes = Array.from(document.body.querySelectorAll('*')).flatMap((element) =>
      Array.from(element.attributes)
        .filter((attribute) => !(element instanceof HTMLInputElement && attribute.name === 'value'))
        .map((attribute) => `${attribute.name}=${attribute.value}`)
    );
    expect(attributes.some((attribute) => /zebrax|abandon/.test(attribute))).toBe(false);
  });
});
