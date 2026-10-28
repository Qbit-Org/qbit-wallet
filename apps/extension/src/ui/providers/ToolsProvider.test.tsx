import React, { useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render, screen } from '@testing-library/react';

import { ToolsContext, ToolsContextType } from '@qbit/wallet-state';
import { ToolsProvider } from './ToolsProvider';

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');

  return {
    ToolsContext: React.createContext(null),
    useI18n: () => ({ t: (key: string) => key })
  };
});

vi.mock('../utils', () => ({
  copyToClipboard: vi.fn(() => Promise.resolve())
}));

vi.mock('../components/ActionComponent/Loading', () => ({
  Loading: () => null
}));

vi.mock('../components/ActionComponent/Tip', () => ({
  Tip: () => null
}));

vi.mock('../components/Text', async () => {
  const React = await import('react');

  return {
    Text: ({ text }: { text: string }) => React.createElement('span', { 'data-testid': 'toast-message' }, text)
  };
});

let tools: ToolsContextType;

function CaptureTools() {
  tools = useContext(ToolsContext) as unknown as ToolsContextType;
  return null;
}

function renderProvider() {
  return render(
    <ToolsProvider>
      <CaptureTools />
    </ToolsProvider>
  );
}

// lib.dom declares showPopover as always present; loosen it so the test can
// remove it to simulate an engine without the Popover API.
type PopoverCapablePrototype = { showPopover?: () => void };

function withShowPopover(implementation: (() => void) | undefined, run: () => void) {
  const prototype = HTMLElement.prototype as unknown as PopoverCapablePrototype;
  const hadOwn = Object.prototype.hasOwnProperty.call(prototype, 'showPopover');
  const original = prototype.showPopover;

  if (implementation) {
    prototype.showPopover = implementation;
  } else {
    delete prototype.showPopover;
  }

  try {
    run();
  } finally {
    if (hadOwn) {
      prototype.showPopover = original;
    } else {
      delete prototype.showPopover;
    }
  }
}

describe('ToastContainer', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('replaces the active error toast instead of stacking duplicates', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      tools.toastError('Invalid password');
    });
    act(() => {
      tools.toastError('Invalid password');
    });

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.querySelectorAll('.toast__dismiss')).toHaveLength(1);
  });

  it('shows the latest error with a restarted countdown', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      tools.toastError('First error');
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    act(() => {
      tools.toastError('Second error');
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Second error');
    expect(alert.textContent).not.toContain('First error');

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(screen.queryByRole('alert')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders concurrent toasts of different presets in a single stacked overlay', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      tools.toastError('Broadcast failed');
      tools.toastSuccess('copied');
    });

    const overlays = document.querySelectorAll('.toast-overlay');
    expect(overlays).toHaveLength(1);
    expect(overlays[0].querySelectorAll('.toast')).toHaveLength(2);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('keeps appending non-error toasts', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      tools.toast('First info');
      tools.toast('Second info');
    });

    expect(document.querySelectorAll('.toast')).toHaveLength(2);
  });

  it('removes the overlay once every toast has closed', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      tools.toastSuccess('Saved');
      tools.toastError('Broadcast failed');
    });

    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(document.querySelector('.toast-overlay')).toBeNull();
  });
});

describe('ToastOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the toast stack in document.body outside the app tree', () => {
    vi.useFakeTimers();
    const { container } = renderProvider();

    act(() => {
      tools.toastError('Broadcast failed');
    });

    const overlay = document.querySelector('.toast-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.parentElement).toBe(document.body);
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.querySelectorAll('.toast')).toHaveLength(1);
  });

  it('promotes the overlay to the browser top layer when the Popover API exists', () => {
    vi.useFakeTimers();
    const showPopover = vi.fn();

    withShowPopover(showPopover, () => {
      renderProvider();

      act(() => {
        tools.toastError('Broadcast failed');
      });

      const overlay = document.querySelector('.toast-overlay') as HTMLElement;
      expect(overlay.getAttribute('popover')).toBe('manual');
      expect(showPopover).toHaveBeenCalledTimes(1);
      expect(showPopover.mock.instances[0]).toBe(overlay);

      // Further toasts reuse the mounted overlay instead of re-promoting it,
      // which would restart the in-flight toast animations.
      act(() => {
        tools.toastSuccess('copied');
      });
      expect(showPopover).toHaveBeenCalledTimes(1);
      expect(overlay.querySelectorAll('.toast')).toHaveLength(2);
    });
  });

  it('re-promotes a freshly mounted overlay once every toast has closed', () => {
    vi.useFakeTimers();
    const showPopover = vi.fn();

    withShowPopover(showPopover, () => {
      renderProvider();

      act(() => {
        tools.toastSuccess('Saved');
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(document.querySelector('.toast-overlay')).toBeNull();

      act(() => {
        tools.toastSuccess('Saved again');
      });
      expect(showPopover).toHaveBeenCalledTimes(2);
    });
  });

  it('stays on the z-index fallback when the Popover API is unavailable', () => {
    vi.useFakeTimers();

    withShowPopover(undefined, () => {
      renderProvider();

      act(() => {
        tools.toastError('Broadcast failed');
      });

      const overlay = document.querySelector('.toast-overlay') as HTMLElement;
      expect(overlay.hasAttribute('popover')).toBe(false);
      expect(overlay.parentElement).toBe(document.body);
      expect(screen.getByRole('alert').textContent).toContain('Broadcast failed');
    });
  });

  it('keeps the toast visible when showPopover throws', () => {
    vi.useFakeTimers();
    const showPopover = vi.fn(() => {
      throw new Error('InvalidStateError');
    });

    withShowPopover(showPopover, () => {
      renderProvider();

      expect(() => {
        act(() => {
          tools.toastError('Broadcast failed');
        });
      }).not.toThrow();

      expect(showPopover).toHaveBeenCalledTimes(1);
      // jsdom applies the user-agent `[popover]:not(:popover-open)` rule but
      // never loads the author stylesheet that overrides it, so the alert is
      // reported as inaccessible here even though browsers still paint it.
      const toast = document.querySelector('.toast-overlay .toast--error') as HTMLElement;
      expect(toast.textContent).toContain('Broadcast failed');
    });
  });
});
