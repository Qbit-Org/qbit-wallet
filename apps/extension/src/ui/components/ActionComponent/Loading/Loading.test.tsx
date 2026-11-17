import { afterEach, describe, expect, it } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';

import { Loading } from '.';

describe('Loading overlay', () => {
  afterEach(cleanup);

  it('shows the Spin ring on its card, with no caption when given no text', () => {
    render(<Loading />);

    const card = screen.getByTestId('loading-overlay');
    const ring = card.querySelector<HTMLElement>('.icon-spin');
    expect(ring?.style.width).toBe('32px');
    expect(card.textContent).toBe('');
  });

  it('shows the text under the ring', () => {
    render(<Loading text="Broadcasting transaction" />);

    const card = screen.getByTestId('loading-overlay');
    expect(card.querySelector('.icon-spin')).toBeTruthy();
    expect(card.textContent).toBe('Broadcasting transaction');
  });
});
