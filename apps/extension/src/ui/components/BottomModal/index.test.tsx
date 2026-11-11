import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BottomModal, useBottomModal } from './index';

function CloseButton() {
  const { requestClose, closing } = useBottomModal();
  return (
    <button data-testid="close" data-closing={closing} onClick={requestClose}>
      close
    </button>
  );
}

const overlay = () => document.querySelector('.popover-container') as HTMLElement;
const sheet = () => overlay().firstElementChild as HTMLElement;

describe('BottomModal', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('lets its content close it the way a tap on the overlay does, once', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <BottomModal onClose={onClose}>
        <CloseButton />
      </BottomModal>
    );

    fireEvent.click(screen.getByTestId('close'));
    fireEvent.click(screen.getByTestId('close'));
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close a modal without onClose', () => {
    vi.useFakeTimers();
    render(
      <BottomModal>
        <CloseButton />
      </BottomModal>
    );

    fireEvent.click(screen.getByTestId('close'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId('close')).toBeTruthy();
  });

  it.each([
    ['its content asks', () => fireEvent.click(screen.getByTestId('close'))],
    ['the overlay is tapped', () => fireEvent.click(overlay())]
  ])('tells its content that it began to close when %s, until it is gone', (_way, startClosing) => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <BottomModal onClose={onClose}>
        <CloseButton />
      </BottomModal>
    );
    expect(screen.getByTestId('close').getAttribute('data-closing')).toBe('false');

    startClosing();

    expect(screen.getByTestId('close').getAttribute('data-closing')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a tap inside the sheet', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <BottomModal onClose={onClose}>
        <span data-testid="inside">inside</span>
      </BottomModal>
    );

    fireEvent.click(screen.getByTestId('inside'));
    fireEvent.click(sheet());
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('spans the window unless given a width, and is centered at that width when given one', () => {
    const { unmount } = render(
      <BottomModal onClose={vi.fn()}>
        <CloseButton />
      </BottomModal>
    );
    expect(sheet().style.width).toBe('100%');
    expect(sheet().style.maxWidth).toBe('');
    expect(sheet().style.marginLeft).toBe('');
    unmount();

    render(
      <BottomModal onClose={vi.fn()} maxWidth={560}>
        <CloseButton />
      </BottomModal>
    );
    expect(sheet().style.width).toBe('100%');
    expect(sheet().style.maxWidth).toBe('560px');
    expect([sheet().style.left, sheet().style.right]).toEqual(['0px', '0px']);
    expect([sheet().style.marginLeft, sheet().style.marginRight]).toEqual(['auto', 'auto']);
  });

  it('calls nothing after it unmounted mid-close', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(
      <BottomModal onClose={onClose}>
        <CloseButton />
      </BottomModal>
    );

    fireEvent.click(screen.getByTestId('close'));
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
