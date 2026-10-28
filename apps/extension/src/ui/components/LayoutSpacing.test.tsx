import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUiType } from '@/ui/web';
import { cleanup, render, screen } from '@testing-library/react';

import { Checkbox } from './Checkbox';
import { Content } from './Content';

vi.mock('@/ui/web', () => ({
  getUiType: vi.fn()
}));

const uiType = (overrides: Partial<ReturnType<typeof getUiType>> = {}) => ({
  isTab: false,
  isNotification: false,
  isPop: false,
  isSidePanel: false,
  ...overrides
});

describe('shared content spacing', () => {
  beforeEach(() => {
    vi.mocked(getUiType).mockReturnValue(uiType());
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ['default extension', {}],
    ['full-tab extension', { isTab: true }],
    ['popup', { isPop: true }],
    ['notification', { isNotification: true }],
    ['side panel', { isSidePanel: true }]
  ])('adds top padding to %s content', (_name, overrides) => {
    vi.mocked(getUiType).mockReturnValue(uiType(overrides));

    render(<Content data-testid="content" />);

    expect(screen.getByTestId('content').style.paddingTop).toBe('16px');
  });

  it('keeps explicit content padding overrides', () => {
    vi.mocked(getUiType).mockReturnValue(uiType({ isPop: true }));

    render(<Content style={{ paddingTop: 4 }} data-testid="content" />);

    expect(screen.getByTestId('content').style.paddingTop).toBe('4px');
  });

  it('keeps the checkbox box on the first line of its label, non-shrinking, and separated from it', () => {
    render(
      <Checkbox data-testid="checkbox">
        <span>Confirmation label</span>
      </Checkbox>
    );

    const label = screen.getByTestId('checkbox');
    const input = screen.getByTestId('checkbox-input');
    const checkboxBox = input.parentElement;

    // Top-aligned: a wrapped label keeps the box beside its first line.
    expect(label.style.alignItems).toBe('flex-start');
    expect(label.style.gap).toBe('8px');
    expect(checkboxBox?.style.flexShrink).toBe('0');
  });
});
