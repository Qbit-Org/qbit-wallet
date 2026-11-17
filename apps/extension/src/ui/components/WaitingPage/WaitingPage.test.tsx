import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render } from '@testing-library/react';

// A fresh module for each test, as for each page: its wait is the page's, and
// the fake timers' performance.now() starts at 0, as at the page's load.
async function loadWaitingPage() {
  vi.resetModules();
  return import('.');
}

const showsSpinner = (container: HTMLElement) => container.querySelector('.icon-spin') !== null;
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('WaitingPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('fills the page, and shows its spinner once the page has been opening for a second', async () => {
    const { WaitingPage, WAITING_PAGE_SPINNER_DELAY_MS } = await loadWaitingPage();
    // The page loaded 400 ms before it showed its first WaitingPage.
    vi.advanceTimersByTime(400);
    const { container } = render(<WaitingPage />);
    const page = container.firstElementChild as HTMLElement;
    expect([page.style.width, page.style.height]).toEqual(['100vw', '100vh']);
    expect(showsSpinner(container)).toBe(false);

    await advance(WAITING_PAGE_SPINNER_DELAY_MS - 400 - 1);
    expect(showsSpinner(container)).toBe(false);
    await advance(1);
    expect(showsSpinner(container)).toBe(true);
  });

  it('counts one wait across the steps that hand over to each other', async () => {
    const { WaitingPage, WAITING_PAGE_SPINNER_DELAY_MS } = await loadWaitingPage();
    const { container, rerender } = render(<WaitingPage key="locale" />);
    await advance(600);

    // The next step's WaitingPage takes the place of the last in one commit.
    rerender(<WaitingPage key="start-up" />);
    await advance(WAITING_PAGE_SPINNER_DELAY_MS - 600 - 1);
    expect(showsSpinner(container)).toBe(false);
    await advance(1);
    expect(showsSpinner(container)).toBe(true);

    // And the spinner stays on as the wait goes on to the step after.
    rerender(<WaitingPage key="first-screen" />);
    expect(showsSpinner(container)).toBe(true);
  });

  it('counts a later wait, after a screen showed, from its own start', async () => {
    const { WaitingPage, WAITING_PAGE_SPINNER_DELAY_MS } = await loadWaitingPage();
    const { container, rerender } = render(<WaitingPage key="opening" />);
    await advance(WAITING_PAGE_SPINNER_DELAY_MS);
    expect(showsSpinner(container)).toBe(true);

    rerender(<span />);
    await advance(60_000);

    rerender(<WaitingPage key="later" />);
    expect(showsSpinner(container)).toBe(false);
    await advance(WAITING_PAGE_SPINNER_DELAY_MS - 1);
    expect(showsSpinner(container)).toBe(false);
    await advance(1);
    expect(showsSpinner(container)).toBe(true);
  });
});
