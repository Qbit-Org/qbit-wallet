import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepTabInside, tabbableElements } from './keyboard';

/** A container of buttons named by their test ids; `unreachable` ones have left the tab order. */
function setUp(names: string[], unreachable: string[] = []) {
  const outside = document.createElement('button');
  outside.dataset.testid = 'outside';
  const container = document.createElement('div');
  container.tabIndex = -1;
  for (const name of names) {
    const button = document.createElement('button');
    button.dataset.testid = name;
    if (unreachable.includes(name)) button.tabIndex = -1;
    container.append(button);
  }
  document.body.append(outside, container);
  const byName = (name: string) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${name}"]`);
    if (!element) throw new Error(`no ${name}`);
    return element;
  };
  return { container, outside, byName };
}

/** One Tab (or Shift+Tab) as the container's keydown handler sees it. */
function tab(container: HTMLElement, shiftKey = false) {
  const event = { key: 'Tab', shiftKey, preventDefault: vi.fn() };
  keepTabInside(event as unknown as React.KeyboardEvent<HTMLElement>, container);
  return event.preventDefault.mock.calls.length > 0;
}

const focused = () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keepTabInside', () => {
  it('wraps Tab from the last element to the first and Shift+Tab from the first to the last', () => {
    const { container, byName } = setUp(['a', 'b', 'c']);

    byName('c').focus();
    expect(tab(container)).toBe(true);
    expect(focused()).toBe('a');

    expect(tab(container, true)).toBe(true);
    expect(focused()).toBe('c');
  });

  it('leaves a Tab between two elements to the browser', () => {
    const { container, byName } = setUp(['a', 'b', 'c']);

    byName('b').focus();
    expect(tab(container)).toBe(false);
    expect(tab(container, true)).toBe(false);
    expect(focused()).toBe('b');
  });

  it('takes focus from the container itself to the last element on Shift+Tab, and leaves Tab to the browser', () => {
    const { container } = setUp(['a', 'b']);

    container.focus();
    expect(tab(container)).toBe(false);
    expect(focused()).toBe('DIV');
    expect(tab(container, true)).toBe(true);
    expect(focused()).toBe('b');
  });

  it('brings focus from outside the container back in', () => {
    const { container, outside } = setUp(['a', 'b']);

    outside.focus();
    expect(tab(container)).toBe(true);
    expect(focused()).toBe('a');
    outside.focus();
    expect(tab(container, true)).toBe(true);
    expect(focused()).toBe('b');
  });

  it('keeps focus on the container when it holds nothing Tab can reach', () => {
    const { container, byName } = setUp(['busy'], ['busy']);

    byName('busy').focus();
    expect(tab(container)).toBe(true);
    expect(focused()).toBe('DIV');
  });

  it('moves focus from an element that left the tab order to the next or previous one Tab can reach', () => {
    const { container, byName } = setUp(['a', 'busy', 'c'], ['busy']);

    byName('busy').focus();
    expect(tab(container)).toBe(true);
    expect(focused()).toBe('c');

    byName('busy').focus();
    expect(tab(container, true)).toBe(true);
    expect(focused()).toBe('a');
  });

  it('wraps from such an element at either end of the container', () => {
    const { container, byName } = setUp(['first-busy', 'a', 'b', 'last-busy'], ['first-busy', 'last-busy']);

    byName('last-busy').focus();
    expect(tab(container)).toBe(true);
    expect(focused()).toBe('a');

    byName('first-busy').focus();
    expect(tab(container, true)).toBe(true);
    expect(focused()).toBe('b');
  });

  it('ignores every key but Tab', () => {
    const { container, byName } = setUp(['a', 'busy'], ['busy']);
    byName('busy').focus();
    const event = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() };

    keepTabInside(event as unknown as React.KeyboardEvent<HTMLElement>, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(focused()).toBe('busy');
  });
});

describe('tabbableElements', () => {
  it('lists the elements Tab reaches, in document order, without those that left the tab order', () => {
    const { container } = setUp(['a', 'busy', 'c'], ['busy']);

    expect(tabbableElements(container).map((element) => element.dataset.testid)).toEqual(['a', 'c']);
  });
});
