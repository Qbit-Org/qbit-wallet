import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Switch } from '.';

afterEach(() => {
  cleanup();
});

describe('Switch', () => {
  it('is a switch, named by its label, with its state', () => {
    const { rerender } = render(<Switch aria-label="Lock when the computer locks" checked />);

    const control = screen.getByRole('switch', { name: 'Lock when the computer locks' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.hasAttribute('aria-disabled')).toBe(false);

    rerender(<Switch aria-label="Lock when the computer locks" checked={false} />);
    expect(control.getAttribute('aria-checked')).toBe('false');

    // Unchecked unless told.
    rerender(<Switch aria-label="Lock when the computer locks" />);
    expect(control.getAttribute('aria-checked')).toBe('false');
  });

  it('can be named by an element on screen instead', () => {
    render(
      <>
        <span id="switch-label">Lock when all windows close</span>
        <Switch aria-labelledby="switch-label" />
      </>
    );

    expect(screen.getByRole('switch', { name: 'Lock when all windows close' })).toBeTruthy();
  });

  it('takes keyboard focus in order', () => {
    render(
      <>
        <button>before</button>
        <Switch aria-label="first" />
        <Switch aria-label="second" />
      </>
    );

    userEvent.tab();
    expect(document.activeElement?.textContent).toBe('before');
    userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'first' }));
    userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'second' }));
  });

  it.each([
    ['Space', ' '],
    ['Enter', 'Enter']
  ])('toggles with %s, once for a held key, without scrolling the page', (_name, key) => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch aria-label="lock" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'lock' });

    // fireEvent returns false when the default was prevented.
    expect(fireEvent.keyDown(control, { key })).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);

    // The key held down repeats; the switch does not flip back and forth.
    fireEvent.keyDown(control, { key, repeat: true });
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(<Switch aria-label="lock" checked onChange={onChange} />);
    fireEvent.keyDown(control, { key });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles from the keyboard once it has focus', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="lock" checked onChange={onChange} />);

    userEvent.tab();
    userEvent.keyboard(' ');
    userEvent.keyboard('{enter}');

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, false);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it('ignores other keys', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="lock" onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'lock' });

    for (const key of ['a', 'Tab', 'ArrowRight', 'Escape']) {
      expect(fireEvent.keyDown(control, { key })).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toggles on a click, as before', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="lock" checked onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: 'lock' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('is announced as disabled, and does nothing by mouse or keyboard, when disabled', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="lock" checked disabled onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'lock' });

    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);
    fireEvent.keyDown(control, { key: ' ' });
    fireEvent.keyDown(control, { key: 'Enter' });
    userEvent.tab();
    userEvent.keyboard(' ');
    userEvent.keyboard('{enter}');

    expect(onChange).not.toHaveBeenCalled();
    // Still reachable, so a screen reader can find it and hear why it does nothing.
    expect(document.activeElement).toBe(control);
  });

  it('keeps its size, colours and look', () => {
    const { rerender } = render(<Switch aria-label="lock" checked />);
    const control = screen.getByRole('switch', { name: 'lock' });

    expect(control.style.width).toBe('44px');
    expect(control.style.height).toBe('22px');
    expect(control.style.borderRadius).toBe('11px');
    expect(control.style.backgroundColor).toBe('var(--qbit-accent)');
    expect(control.style.cursor).toBe('pointer');
    expect(control.style.opacity).toBe('1');
    expect((control.firstChild as HTMLElement).style.left).toBe('24px');

    rerender(<Switch aria-label="lock" size="small" disabled className="extra" style={{ marginLeft: 4 }} />);
    expect(control.style.width).toBe('28px');
    expect(control.style.height).toBe('16px');
    expect(control.style.backgroundColor).toBe('rgb(184, 199, 190)');
    expect(control.style.cursor).toBe('not-allowed');
    expect(control.style.opacity).toBe('0.6');
    expect(control.style.marginLeft).toBe('4px');
    expect((control.firstChild as HTMLElement).style.left).toBe('2px');
    // The focus ring's class, and the caller's own.
    expect(control.className).toBe('qbit-switch extra');
  });
});
