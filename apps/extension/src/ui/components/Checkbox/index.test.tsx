import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Checkbox } from './index';

describe('Checkbox', () => {
  // Also clean before: without worker isolation a previous file's render can leak into this DOM.
  beforeEach(cleanup);
  afterEach(cleanup);

  it('top-aligns the box with the first line of a multi-line label', () => {
    render(
      <Checkbox checked={false} data-testid="confirm">
        <span>A confirmation whose label wraps onto two or three lines still keeps the box beside the first line.</span>
      </Checkbox>
    );

    const label = screen.getByTestId('confirm');
    expect(label.style.alignItems).toBe('flex-start');
    const box = screen.getByTestId('confirm-input').parentElement as HTMLElement;
    expect(box.style.flexShrink).toBe('0');
    // The 15px box is nudged down a pixel so it centres on a 14px first line.
    expect(box.style.marginTop).toBe('1px');
  });

  it('keeps a caller-supplied style override', () => {
    render(<Checkbox checked={false} data-testid="confirm" style={{ marginBottom: 8 }} />);
    const label = screen.getByTestId('confirm');
    expect(label.style.alignItems).toBe('flex-start');
    expect(label.style.marginBottom).toBe('8px');
  });

  it('reports the new checked state and ignores clicks while disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} onChange={onChange} data-testid="confirm" />);
    fireEvent.click(screen.getByTestId('confirm-input'));
    expect(onChange).toHaveBeenCalledWith({ target: { checked: true } });

    onChange.mockClear();
    rerender(<Checkbox checked={false} onChange={onChange} disabled data-testid="confirm" />);
    fireEvent.click(screen.getByTestId('confirm-input'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
