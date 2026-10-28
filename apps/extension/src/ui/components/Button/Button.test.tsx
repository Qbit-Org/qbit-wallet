import { afterEach, describe, expect, it, vi } from 'vitest';

import { colors } from '@/ui/theme/colors';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Button } from '.';

describe('Button border hover state', () => {
  afterEach(() => {
    cleanup();
  });

  it('restores the default border colour of a home button after hover-off', () => {
    render(<Button preset="home" text="Receive" data-testid="home-button" />);

    const button = screen.getByTestId('home-button');
    expect(button.style.borderColor).toBe(colors.border);

    fireEvent.mouseEnter(button);
    expect(button.style.borderColor).toBe(colors.accent);

    // Hover-off must fall back to the preset border colour, not to an unset
    // value that the browser resolves as currentColor (the dark text colour).
    fireEvent.mouseLeave(button);
    expect(button.style.borderColor).toBe(colors.border);
    expect(button.style.borderColor).not.toBe('');
  });

  it.each([
    ['default', colors.accent, colors.ink],
    ['primary', colors.primary, colors.accentHover],
    ['defaultV2', colors.accent, colors.ink],
    ['primaryV2', colors.primary, colors.accentHover],
    ['homeGold', colors.accent, colors.ink]
  ] as const)(
    'restores the default border colour of a %s button after hover-off',
    (preset, baseBorderColor, hoverBorderColor) => {
      render(<Button preset={preset} text="Action" data-testid={`${preset}-button`} />);

      const button = screen.getByTestId(`${preset}-button`);
      expect(button.style.borderColor).toBe(baseBorderColor);

      fireEvent.mouseEnter(button);
      expect(button.style.borderColor).toBe(hoverBorderColor);

      fireEvent.mouseLeave(button);
      expect(button.style.borderColor).toBe(baseBorderColor);
    }
  );
});

describe('Button loading state', () => {
  afterEach(() => {
    cleanup();
  });

  it('ignores clicks and shows a spinner while loading', () => {
    const onClick = vi.fn();
    render(<Button preset="primary" text="Create" loading onClick={onClick} data-testid="loading-button" />);

    const button = screen.getByTestId('loading-button');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    expect(button.querySelector('.icon-spin')).toBeTruthy();
    expect(button.style.cursor).toBe('not-allowed');
  });

  it('suppresses the hover style while loading', () => {
    render(<Button preset="primary" text="Create" loading data-testid="loading-button" />);

    const button = screen.getByTestId('loading-button');
    fireEvent.mouseEnter(button);
    expect(button.style.borderColor).toBe(colors.primary);
  });

  it('clicks through and hides the spinner when not loading', () => {
    const onClick = vi.fn();
    render(<Button preset="primary" text="Create" onClick={onClick} data-testid="idle-button" />);

    const button = screen.getByTestId('idle-button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.querySelector('.icon-spin')).toBeNull();
  });

  it.each([
    'default',
    'primary',
    'danger',
    'delete',
    'approval',
    'bar',
    'defaultV2',
    'primaryV2',
    'home',
    'homeGold',
    'minimal',
    'minimal2',
    'swap'
  ] as const)('shows the spinner and ignores clicks for a loading %s button', (preset) => {
    const onClick = vi.fn();
    render(<Button preset={preset} text="Action" loading onClick={onClick} data-testid={`${preset}-loading`} />);

    const button = screen.getByTestId(`${preset}-loading`);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.querySelector('.icon-spin')).toBeTruthy();
  });
});
