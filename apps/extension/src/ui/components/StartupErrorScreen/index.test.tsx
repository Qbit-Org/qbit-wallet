import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import englishMessages from '@/_locales/en/messages.json';
import frenchMessages from '@/_locales/fr/messages.json';
import { browserRuntimeReload } from '@/background/webapi/browser';
import { i18nService } from '@/shared/utils/i18n';

import { STARTUP_ERROR_ENGLISH_TEXT, StartupErrorScreen } from './index';

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

// The real wrapper, watched, so the test sees both that Retry goes through it
// and what it does.
vi.mock('@/background/webapi/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/background/webapi/browser')>();
  return { ...actual, browserRuntimeReload: vi.fn(actual.browserRuntimeReload) };
});

const bundles: Record<string, unknown> = { en: englishMessages, fr: frenchMessages };
// ./_locales/<locale>/messages.json
const serveBundle = async (url: string) => ({ json: async () => bundles[url.split('/').at(-2) ?? ''] });
const fetchLocale = vi.fn(serveBundle);

// Let the locale load settle, however it ends.
const localeSettled = (loading: Promise<void>) =>
  act(async () => {
    await loading.catch(() => undefined);
  });

const STORED_SETTINGS_UNREADABLE =
  'Qbit Wallet could not read its stored settings, so it stopped without changing them.';

describe('StartupErrorScreen', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', fetchLocale);
    i18nService.init({});
  });

  beforeEach(() => {
    fetchLocale.mockImplementation(serveBundle);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('says the stored settings could not be read, and Retry restarts the wallet without writing', async () => {
    render(<StartupErrorScreen reason="stored-settings-unreadable" />);

    expect(await screen.findByText('Qbit Wallet could not start')).toBeTruthy();
    expect(screen.getByText(STORED_SETTINGS_UNREADABLE)).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));

    expect(browserRuntimeReload).toHaveBeenCalledTimes(1);
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

  it('shows the screen in English at once, before the locale has loaded', () => {
    localStorage.setItem('i18nextLng', 'fr');
    fetchLocale.mockImplementation(() => new Promise(() => undefined));

    render(<StartupErrorScreen reason="stored-settings-unreadable" />);

    expect(screen.getByText('Qbit Wallet could not start')).toBeTruthy();
    expect(screen.getByText(STORED_SETTINGS_UNREADABLE)).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('stays in English, and never shows message keys, when the locale bundle cannot load', async () => {
    localStorage.setItem('i18nextLng', 'ja');
    fetchLocale.mockRejectedValue(new TypeError('Failed to fetch'));
    const changing = vi.spyOn(i18nService, 'changeLanguage');

    render(<StartupErrorScreen reason="stored-settings-unreadable" />);
    await localeSettled(changing.mock.results[0]?.value);

    expect(changing).toHaveBeenCalledWith('ja');
    expect(screen.getByText('Qbit Wallet could not start')).toBeTruthy();
    expect(screen.getByText(STORED_SETTINGS_UNREADABLE)).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText(/startup_error_/)).toBeNull();
  });

  it('switches to the language the wallet last showed once it loads', async () => {
    localStorage.setItem('i18nextLng', 'fr');
    render(<StartupErrorScreen reason="stored-settings-unreadable" />);

    expect(await screen.findByText(frenchMessages.startup_error_title.message)).toBeTruthy();
    expect(screen.getByText(frenchMessages.startup_error_retry.message)).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('falls back to the same English text the locale file has', () => {
    const english = englishMessages as Record<string, { message: string }>;

    for (const [key, text] of Object.entries(STARTUP_ERROR_ENGLISH_TEXT)) {
      expect(text, key).toBe(english[key]?.message);
    }
  });
});
