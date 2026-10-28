import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import englishMessages from '@/_locales/en/messages.json';
import frenchMessages from '@/_locales/fr/messages.json';
import { i18nService } from '@/shared/utils/i18n';

import { StartupErrorScreen } from './index';

const browser = vi.hoisted(() => {
  const api = {
    runtime: { reload: vi.fn() },
    storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() } }
  };
  // Set before the imports run, so a module that captures the browser API on
  // load captures this one.
  globalThis.chrome = api as unknown as typeof chrome;
  return api;
});

const messages: Record<string, unknown> = { en: englishMessages, fr: frenchMessages };

describe('StartupErrorScreen', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        // ./_locales/<locale>/messages.json
        json: async () => messages[url.split('/').at(-2) ?? '']
      }))
    );
    i18nService.init({});
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('says the stored settings could not be read, and Retry restarts the wallet without writing', async () => {
    render(<StartupErrorScreen reason="stored-settings-unreadable" />);

    expect(await screen.findByText('Qbit Wallet could not start')).toBeTruthy();
    expect(
      screen.getByText('Qbit Wallet could not read its stored settings, so it stopped without changing them.')
    ).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));

    expect(browser.runtime.reload).toHaveBeenCalledTimes(1);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(browser.storage.local.remove).not.toHaveBeenCalled();
    expect(browser.storage.local.clear).not.toHaveBeenCalled();
  });

  it('does not blame the stored settings for another start-up failure', async () => {
    render(<StartupErrorScreen reason="unknown" />);

    expect(await screen.findByText('Something went wrong while Qbit Wallet was starting.')).toBeTruthy();
    expect(screen.queryByText(/stored settings/)).toBeNull();
  });

  it('speaks the language the wallet last showed', async () => {
    localStorage.setItem('i18nextLng', 'fr');
    render(<StartupErrorScreen reason="stored-settings-unreadable" />);

    expect(await screen.findByText(frenchMessages.startup_error_title.message)).toBeTruthy();
    expect(screen.getByText(frenchMessages.startup_error_retry.message)).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });
});
