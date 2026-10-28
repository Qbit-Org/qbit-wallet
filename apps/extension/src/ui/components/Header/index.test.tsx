import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Header } from './index';

describe('Header', () => {
  afterEach(() => {
    cleanup();
  });

  it('invokes onBack when the back button is clicked', () => {
    const onBack = vi.fn();
    render(<Header onBack={onBack} title="Restore from Mnemonics" />);

    fireEvent.click(screen.getByTestId('header-back-button'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('fades the back button and ignores clicks while backDisabled', () => {
    const onBack = vi.fn();
    render(<Header onBack={onBack} backDisabled title="Restore from Mnemonics" />);

    const backButton = screen.getByTestId('header-back-button');
    expect(backButton.style.opacity).toBe('0.4');
    expect(backButton.style.cursor).toBe('not-allowed');

    fireEvent.click(backButton);

    expect(onBack).not.toHaveBeenCalled();
  });

  it('keeps the pointer affordance when backDisabled is not set', () => {
    render(<Header onBack={() => undefined} title="Restore from Mnemonics" />);

    expect(screen.getByTestId('header-back-button').style.cursor).toBe('pointer');
  });
});
