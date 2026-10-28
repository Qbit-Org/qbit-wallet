import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Toast } from '.';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key })
}));

vi.mock('../../Text', async () => {
  const React = await import('react');

  return {
    Text: ({ text, preset }: { text: string; preset: string }) =>
      React.createElement('span', { 'data-testid': 'toast-message', 'data-preset': preset }, text)
  };
});

describe('Toast', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps an error toast visible for eight seconds before closing it', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(<Toast preset="error" content="Readable error" onClose={onClose} />);

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the enhanced error presentation and countdown', () => {
    vi.useFakeTimers();

    render(<Toast preset="error" content="Readable error" onClose={vi.fn()} />);

    const toast = screen.getByRole('alert');
    const message = screen.getByTestId('toast-message');
    const countdown = screen.getByTestId('error-toast-countdown');
    const closeIcon = screen.getByTestId('error-toast-close-icon');

    expect(toast.classList.contains('toast--error')).toBe(true);
    expect(toast.style.padding).toBe('12px 44px 12px 16px');
    expect(toast.style.borderRadius).toBe('6px');
    expect(toast.style.getPropertyValue('--toast-duration')).toBe('8000ms');
    expect(message.getAttribute('data-preset')).toBe('regular-bold');
    expect(countdown.querySelector('.toast__countdown-progress')).not.toBeNull();
    expect(closeIcon.getAttribute('width')).toBe('8.8');
    expect(closeIcon.getAttribute('height')).toBe('8.8');
    expect(closeIcon.querySelector('path')?.getAttribute('stroke-width')).toBe('2.2');
    expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();
  });

  it('dismisses an error toast immediately without calling onClose again', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(<Toast preset="error" content="Readable error" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the auto-dismiss timer when unmounted', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<Toast preset="error" content="Readable error" onClose={onClose} />);

    unmount();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('preserves the existing timing and presentation for non-error toasts', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(<Toast preset="success" content="Saved" onClose={onClose} />);

    const toast = container.querySelector('.toast') as HTMLElement;
    expect(toast.classList.contains('toast--error')).toBe(false);
    expect(toast.style.getPropertyValue('--toast-duration')).toBe('2000ms');
    expect(screen.queryByRole('button')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
