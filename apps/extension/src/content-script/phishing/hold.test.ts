import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_PHISHING_DENYLIST } from '@qbit/phishing-detect';

import { type HeldPage, holdDenylistedPage, WARNING_PAGE_TIMEOUT_MS } from './hold';
import { forgetRelease } from './release';

type Reply = (response?: unknown) => void;

const [BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string];
const RELEASE_KEY = 'qbit-wallet:phishing-released';

/** The page's sessionStorage, which can refuse writes or every access. */
class PageStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/**
 * The tab's history entry for the page. Like a browser's, it keeps the form
 * of a POST that loaded the page, which a reload sends again, until the page
 * replaces the entry.
 */
class PageHistory {
  state: unknown = null;
  method: 'GET' | 'POST' = 'GET';
  refuses = false;

  replaceState(state: unknown, _unused: string, url?: string | URL | null): void {
    if (this.refuses) throw new DOMException('The document is not fully active.', 'SecurityError');
    if (url != null && new URL(url, location.href).href !== location.href) {
      throw new Error('The entry was replaced with another URL');
    }
    this.state = state;
    this.method = 'GET';
  }
}

let storage: PageStorage;
let pageHistory: PageHistory;
// The method of each reload the page asked for.
let reloads: string[];
let reload: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let verdicts: unknown[];
let sendMessage: ReturnType<typeof vi.fn>;

/** Puts the content script on a top-frame page at the URL, as a new load would. */
function loadPage(url: string) {
  const parsed = new URL(url);
  vi.stubGlobal('location', { href: parsed.href, hostname: parsed.hostname, protocol: parsed.protocol, reload });
}

function notice() {
  return document.getElementById('qbit-wallet-phishing-notice');
}

/** Holds the page, which the test expects to be held. */
function hold(): HeldPage {
  const page = holdDenylistedPage();
  if (!page) throw new Error('The page was not held');
  return page;
}

function retryButton(): HTMLButtonElement {
  const button = notice()?.querySelector('button');
  if (!button) throw new Error('No notice with a retry button');
  return button;
}

beforeEach(() => {
  // A held page explains itself after a timeout, which no test leaves
  // running for the next one.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  storage = new PageStorage();
  pageHistory = new PageHistory();
  reloads = [];
  reload = vi.fn(() => reloads.push(pageHistory.method));
  stop = vi.fn();
  verdicts = [];
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('history', pageHistory);
  vi.stubGlobal('stop', stop);
  // A load the user started, rather than a reload.
  vi.stubGlobal('performance', { getEntriesByType: () => [{ type: 'navigate' }] });
  // Each CHECK_PHISHING gets the next queued verdict, then none.
  sendMessage = vi.fn((message: { type: string }, callback?: Reply) => {
    callback?.(message.type === 'CHECK_PHISHING' ? verdicts.shift() : { success: true });
  });
  const messages: Record<string, string> = {
    danger_potential_phishing_website_detected: 'Danger! Potential phishing website detected',
    phishing_page_held_message: 'Qbit Wallet stopped this page.',
    phishing_page_held_unreleasable_message: 'The page does not keep the record that lets it load.',
    phishing_page_held_released_message: 'Select Try again to load it.',
    try_again: 'Try again'
  };
  vi.stubGlobal('chrome', {
    runtime: { id: 'qbit', sendMessage },
    i18n: { getMessage: (name: string) => messages[name] ?? '' }
  });
  loadPage(`https://${BLOCKED_HOST}/claim?ref=1`);
  document.documentElement.replaceChildren(document.createElement('head'), document.createElement('body'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('holding a denylisted page', () => {
  it('stops a top-frame page on a denylisted host before its script runs', () => {
    expect(holdDenylistedPage()).toBeDefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    ['a host outside the denylist', 'https://example.com/'],
    ['a page without an http(s) URL', 'file:///tmp/page.html']
  ])('leaves %s alone', (_label, url) => {
    loadPage(url);

    expect(holdDenylistedPage()).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it('leaves a frame alone', () => {
    vi.stubGlobal('top', {});

    expect(holdDenylistedPage()).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it('shows the notice in an SVG document, under a new HTML root', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.replaceChild(svg, document.documentElement);

    hold().settle('unknown');

    expect(document.documentElement.localName).toBe('html');
    expect(document.documentElement.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(notice()?.textContent).toContain(BLOCKED_HOST);
  });

  it('holds a subdomain, including one outside DNS syntax', () => {
    loadPage(`https://a_b.${BLOCKED_HOST}/`);

    expect(holdDenylistedPage()).toBeDefined();
  });
});

describe('releasing a held page', () => {
  it('reloads once a page the user proceeded to, which then loads without a hold', () => {
    hold().settle('proceeded');

    expect(storage.values.get(RELEASE_KEY)).toBe(BLOCKED_HOST);
    expect(reload).toHaveBeenCalledOnce();

    // The reload: the same tab and origin, so the release is there.
    stop.mockClear();
    expect(holdDenylistedPage()).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps a page held, without reloading, when the content script cannot write sessionStorage', () => {
    storage.failWrites = true;

    hold().settle('proceeded');

    expect(stop).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(notice()?.textContent).toContain('The page does not keep the record that lets it load.');
  });

  it('keeps a sandboxed page held, as its server cannot turn the hold off by blocking sessionStorage', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      }
    });

    hold().settle('proceeded');

    expect(stop).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(notice()).not.toBeNull();
    expect(() => forgetRelease()).not.toThrow();
  });

  it('counts a load the browser reports nothing about as a reload', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [] });

    hold().settle('proceeded');

    expect(reload).not.toHaveBeenCalled();
    expect(notice()?.textContent).toContain('Select Try again to load it.');
  });

  it('does not claim the user proceeded when a clear page cannot be released', () => {
    const page = hold();
    storage.failWrites = true;

    page.settle('clear');

    expect(reload).not.toHaveBeenCalled();
    expect(notice()?.textContent).toContain('The page does not keep the record that lets it load.');
  });

  it('shows the notice instead of reloading when the release cannot be recorded', () => {
    const page = hold();
    storage.failWrites = true;

    page.settle('proceeded');

    expect(reload).not.toHaveBeenCalled();
    expect(notice()).not.toBeNull();
  });

  it('does not reload by itself a page that was held again on a reload', async () => {
    // As when a Clear-Site-Data header took the release away.
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: 'reload' }] });
    const page = hold();

    page.settle('proceeded');

    expect(reload).not.toHaveBeenCalled();
    expect(storage.values.get(RELEASE_KEY)).toBe(BLOCKED_HOST);
    expect(notice()?.textContent).toContain('Select Try again to load it.');

    // The user can still ask for the reload.
    verdicts.push({ isPhishing: false, isDenylisted: true });
    retryButton().click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('lets a page that forged its release run, and holds it again once its check sends it to the warning', () => {
    // Only a page that already ran script can write the release itself.
    storage.values.set(RELEASE_KEY, BLOCKED_HOST);
    expect(holdDenylistedPage()).toBeUndefined();

    // The content script forgets the release on a phishing verdict.
    forgetRelease();

    expect(holdDenylistedPage()).toBeDefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a page held without reloading once a Proceed from an earlier session has ended', () => {
    storage.values.set(RELEASE_KEY, BLOCKED_HOST);
    expect(holdDenylistedPage()).toBeUndefined();
    forgetRelease();

    hold().settle('phishing');

    expect(reload).not.toHaveBeenCalled();
    expect(storage.values.has(RELEASE_KEY)).toBe(false);
  });
});

describe('releasing a page that a form POST loaded', () => {
  beforeEach(() => {
    // Its server got the form before the hold stopped the page.
    pageHistory.method = 'POST';
  });

  it('reloads it with a GET, so that the release does not send the form again', () => {
    hold().settle('proceeded');

    expect(reloads).toEqual(['GET']);
    expect(storage.values.get(RELEASE_KEY)).toBe(BLOCKED_HOST);
  });

  it('keeps the state the page saved in its history entry', () => {
    pageHistory.state = { step: 2 };

    hold().settle('clear');

    expect(reloads).toEqual(['GET']);
    expect(pageHistory.state).toEqual({ step: 2 });
  });

  it('reloads it with a GET when the user asks, after it was held again on a reload', async () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: 'reload' }] });
    hold().settle('proceeded');
    expect(reloads).toEqual([]);

    verdicts.push({ isPhishing: false, isDenylisted: true });
    retryButton().click();

    await vi.waitFor(() => expect(reloads).toEqual(['GET']));
  });

  it('reloads it with a GET on retry once the extension was reloaded', () => {
    hold().settle('unknown');
    vi.stubGlobal('chrome', { runtime: { id: undefined }, i18n: { getMessage: () => '' } });

    retryButton().click();

    expect(reloads).toEqual(['GET']);
  });

  it('does not reload it by itself when its history entry cannot be replaced', () => {
    pageHistory.refuses = true;

    hold().settle('proceeded');

    expect(reload).not.toHaveBeenCalled();
    expect(storage.values.get(RELEASE_KEY)).toBe(BLOCKED_HOST);
    expect(notice()?.textContent).toContain('Select Try again to load it.');
  });
});

describe('a held page that stays held', () => {
  it('explains itself when the check does not answer in time, and still takes a late answer', () => {
    const page = hold();

    vi.advanceTimersByTime(WARNING_PAGE_TIMEOUT_MS - 1);
    expect(notice()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(notice()?.textContent).toContain('Qbit Wallet stopped this page.');

    page.settle('proceeded');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('waits for the warning page, then explains itself if it has not arrived', () => {
    hold().settle('phishing');

    vi.advanceTimersByTime(WARNING_PAGE_TIMEOUT_MS - 1);
    expect(notice()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(notice()?.textContent).toContain(BLOCKED_HOST);
    expect(reload).not.toHaveBeenCalled();
  });

  it('explains at once that the check did not complete, and offers a retry', () => {
    hold().settle('unknown');

    const shown = notice();
    if (!shown) throw new Error('No notice');
    expect(shown.getAttribute('role')).toBe('alert');
    expect(shown.querySelector('h1')?.textContent).toBe('Danger! Potential phishing website detected');
    expect(shown.textContent).toContain(BLOCKED_HOST);
    expect(shown.textContent).toContain('Qbit Wallet stopped this page.');
    expect(shown.querySelector('button')?.textContent).toBe('Try again');
    expect(reload).not.toHaveBeenCalled();
  });

  it('checks again on retry and reloads once the background lets the page through', async () => {
    hold().settle('unknown');
    verdicts.push({ isPhishing: false, isDenylisted: true });

    retryButton().click();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storage.values.get(RELEASE_KEY)).toBe(BLOCKED_HOST);
  });

  it('keeps the notice when the retry gets no answer either', async () => {
    hold().settle('unknown');

    retryButton().click();

    // A check and its one retry, both unanswered.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(retryButton().disabled).toBe(false));
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelectorAll('#qbit-wallet-phishing-notice')).toHaveLength(1);
  });

  it('asks for the warning page again when the retry finds the page phishing', async () => {
    hold().settle('unknown');
    verdicts.push({ isPhishing: true, isDenylisted: true });

    retryButton().click();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'REDIRECT_TO_PHISHING_PAGE', hostname: BLOCKED_HOST }),
        expect.any(Function)
      )
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads on retry once the extension was reloaded, as only a new content script can ask', () => {
    hold().settle('unknown');
    vi.stubGlobal('chrome', { runtime: { id: undefined }, i18n: { getMessage: () => '' } });

    retryButton().click();

    expect(reload).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
