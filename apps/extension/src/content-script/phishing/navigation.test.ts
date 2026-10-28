import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_PHISHING_DENYLIST, PhishingService } from '@qbit/phishing-detect';
import { PHISHING_PAGE_PROBE } from '@qbit/wallet-shared';

import { allowLinksWithinProceededPage, isBundledDenylistedUrl, setupNavigationListeners } from './navigation';

type Reply = (response?: unknown) => void;
type MessageListener = (message: unknown, sender: { id?: string }, sendResponse: Reply) => boolean;

const [BLOCKED_HOST, OTHER_BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as [string, string];
const BLOCKED_URL = `http://${BLOCKED_HOST}/claim?ref=1`;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const LOST_MESSAGE = { message: 'Could not establish connection. Receiving end does not exist.' };

let respond: (message: { type: string; url: string }) => unknown;
let lastError: { message: string } | undefined;
const messageListeners: MessageListener[] = [];
const runtime: {
  id?: string;
  lastError?: { message: string };
  sendMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (listener: MessageListener) => void };
} = {
  id: 'qbit',
  sendMessage: vi.fn(),
  onMessage: { addListener: (listener) => messageListeners.push(listener) }
};
// jsdom cannot navigate, so the anchor the content script clicks to follow a
// link is recorded instead.
let anchorClick: ReturnType<typeof vi.spyOn>;
// Clicks that reached the page's own listeners.
const pageClicks: Event[] = [];
const recordPageClick = (e: Event) => pageClicks.push(e);

function link(attributes: Record<string, string>, text = 'Claim'): HTMLAnchorElement {
  const anchor = document.createElement('a');
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  anchor.textContent = text;
  document.body.append(anchor);
  return anchor;
}

/** Dispatches a click and reports whether it was cancelled by the time dispatch returned. */
function click(target: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init });
  let cancelled: boolean | undefined;
  // Reads the outcome after the other listeners, then keeps jsdom, which
  // cannot navigate, from trying.
  const settle = (e: Event) => {
    cancelled = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener('click', settle);
  target.dispatchEvent(event);
  window.removeEventListener('click', settle);
  return cancelled ?? event.defaultPrevented;
}

function sentMessages() {
  return runtime.sendMessage.mock.calls.map(([message]) => message);
}

/** The links the content script followed itself. */
function followedLinks(): HTMLAnchorElement[] {
  return anchorClick.mock.contexts as HTMLAnchorElement[];
}

describe('content-script link interception', () => {
  beforeAll(() => {
    vi.stubGlobal('chrome', { runtime });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // One listener for the file, as the content script installs one per page.
    setupNavigationListeners();
    document.addEventListener('click', recordPageClick);
  });

  afterAll(() => {
    document.removeEventListener('click', recordPageClick);
    anchorClick.mockRestore();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    runtime.id = 'qbit';
    lastError = undefined;
    pageClicks.length = 0;
    respond = () => ({ isPhishing: true, redirected: true });
    runtime.sendMessage.mockImplementation((message: { type: string; url: string }, callback?: Reply) => {
      runtime.lastError = lastError;
      callback?.(lastError ? undefined : respond(message));
      runtime.lastError = undefined;
    });
  });

  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('cancels a click on a denylisted link before dispatch returns and asks for the warning page', () => {
    expect(click(link({ href: BLOCKED_URL }))).toBe(true);

    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
    expect(followedLinks()).toEqual([]);
    // The page still sees the click, as cancelled.
    expect(pageClicks).toHaveLength(1);
  });

  it.each([
    ['a subdomain', `https://www.${BLOCKED_HOST}/`],
    ['an upper-case host', `https://${BLOCKED_HOST.toUpperCase()}/`],
    ['a host with a trailing dot', `https://${BLOCKED_HOST}./`],
    ['a host with a port and credentials', `https://user@${BLOCKED_HOST}:8443/`]
  ])('cancels a click on a link to %s', (_label, href) => {
    expect(click(link({ href }))).toBe(true);
  });

  it('cancels a click on an element inside the link', () => {
    const anchor = link({ href: BLOCKED_URL }, '');
    const image = document.createElement('img');
    anchor.append(image);

    expect(click(image)).toBe(true);
    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
  });

  it('cancels a click on a link inside an open shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const anchor = document.createElement('a');
    anchor.href = BLOCKED_URL;
    host.attachShadow({ mode: 'open' }).append(anchor);

    expect(click(anchor)).toBe(true);
  });

  it('cancels a click on an SVG link', () => {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    const anchor = document.createElementNS(SVG_NAMESPACE, 'a');
    anchor.setAttribute('href', BLOCKED_URL);
    const shape = document.createElementNS(SVG_NAMESPACE, 'rect');
    anchor.append(shape);
    svg.append(anchor);
    document.body.append(svg);

    expect(click(shape)).toBe(true);
    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
  });

  it('cancels a click the page stops from propagating', () => {
    const anchor = link({ href: BLOCKED_URL });
    window.addEventListener('click', (e) => e.stopImmediatePropagation(), { capture: true, once: true });

    expect(click(anchor)).toBe(true);
  });

  it('follows the link, with its rel and referrer policy, when the user chose Proceed for the host', () => {
    respond = () => ({ isPhishing: false, redirected: false });
    // A host of its own, as the content script remembers it from now on.
    const proceededUrl = `https://rel.${BLOCKED_HOST}/claim?ref=1`;

    expect(click(link({ href: proceededUrl, rel: 'noreferrer', referrerpolicy: 'no-referrer' }))).toBe(true);

    const [followed] = followedLinks();
    expect(followedLinks()).toHaveLength(1);
    expect(followed?.href).toBe(proceededUrl);
    expect(followed?.target).toBe('_self');
    expect(followed?.getAttribute('rel')).toBe('noreferrer');
    expect(followed?.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The page's listeners see only the user's click.
    expect(followed?.isConnected).toBe(false);
    expect(pageClicks).toHaveLength(1);
  });

  it('does not follow the link when the page has navigated itself meanwhile', async () => {
    const anchor = link({ href: BLOCKED_URL });
    // For example a router that handles the click and pushes a new entry.
    anchor.addEventListener('click', () => window.history.pushState(null, '', '/routed'));
    // Proceed, answered once the click has finished dispatching.
    runtime.sendMessage.mockImplementationOnce((_message: unknown, callback?: Reply) => {
      queueMicrotask(() => callback?.({ isPhishing: false, redirected: false }));
    });

    try {
      expect(click(anchor)).toBe(true);
      await Promise.resolve();
      expect(runtime.sendMessage).toHaveBeenCalledOnce();
      expect(followedLinks()).toEqual([]);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does nothing more once the page has been in the back/forward cache', async () => {
    // The tab moved on to the warning page; the channel closed, and the
    // callback runs only after the user came back to this page.
    let reply!: () => void;
    runtime.sendMessage.mockImplementationOnce((_message: unknown, callback?: Reply) => {
      reply = () => {
        runtime.lastError = { message: 'The message channel is closed.' };
        callback?.(undefined);
        runtime.lastError = undefined;
      };
    });

    expect(click(link({ href: BLOCKED_URL }))).toBe(true);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    reply();

    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(followedLinks()).toEqual([]);
  });

  it('still follows the link when the page only changed its fragment meanwhile', async () => {
    const anchor = link({ href: BLOCKED_URL });
    anchor.addEventListener('click', () => window.history.replaceState(null, '', '#section'));
    runtime.sendMessage.mockImplementationOnce((_message: unknown, callback?: Reply) => {
      queueMicrotask(() => callback?.({ isPhishing: true, redirected: false }));
    });

    try {
      expect(click(anchor)).toBe(true);
      await Promise.resolve();
      expect(followedLinks().map((followed) => followed.href)).toEqual([BLOCKED_URL]);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('follows the link, which the block rule still stops, when the redirect failed', () => {
    respond = () => ({ isPhishing: true, redirected: false, error: 'Error: No tab with id: 7' });

    click(link({ href: BLOCKED_URL }));
    expect(followedLinks().map((anchor) => anchor.href)).toEqual([BLOCKED_URL]);
  });

  it('asks once more when the first message is lost, then follows the link', () => {
    lastError = LOST_MESSAGE;

    click(link({ href: BLOCKED_URL }));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(followedLinks().map((anchor) => anchor.href)).toEqual([BLOCKED_URL]);
  });

  it('does not follow the link when the retry gets the warning page', () => {
    lastError = LOST_MESSAGE;
    runtime.sendMessage.mockImplementationOnce((_message: unknown, callback?: Reply) => {
      runtime.lastError = lastError;
      lastError = undefined;
      callback?.(undefined);
      runtime.lastError = undefined;
    });

    click(link({ href: BLOCKED_URL }));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(followedLinks()).toEqual([]);
  });

  it('leaves a click on a clear link to the browser without asking the background', () => {
    expect(click(link({ href: 'https://example.com/claim' }))).toBe(false);
    expect(click(link({ href: '/claim' }))).toBe(false);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['a new tab target', { target: '_blank' }, {}],
    ['a new tab target in capitals', { target: ' _BLANK ' }, {}],
    ['a Ctrl+click', {}, { ctrlKey: true }],
    ['a Cmd+click', {}, { metaKey: true }],
    ['a Shift+click', {}, { shiftKey: true }]
  ])('leaves %s to the background as a new tab, which the redirect rule may warn in', (_label, attributes, init) => {
    expect(click(link({ href: BLOCKED_URL, ...attributes }), init)).toBe(false);
    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL, newTab: true }]);
  });

  it.each([
    ['a named target', { target: 'other' }, {}],
    ['an Alt+click', {}, { altKey: true }],
    ['a non-primary button', {}, { button: 1 }],
    ['a Ctrl+Alt+click', {}, { ctrlKey: true, altKey: true }]
  ])('leaves %s to the background, which sends this tab to the warning page', (_label, attributes, init) => {
    expect(click(link({ href: BLOCKED_URL, ...attributes }), init)).toBe(false);
    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
  });

  it('cancels a link whose target names this window', () => {
    window.name = 'app';
    try {
      expect(click(link({ href: BLOCKED_URL, target: 'app' }))).toBe(true);
      expect(click(link({ href: BLOCKED_URL, target: 'App' }))).toBe(false);
    } finally {
      window.name = '';
    }
  });

  it('leaves a link to a new tab by the base target to the background', () => {
    const base = document.createElement('base');
    base.target = '_blank';
    document.head.append(base);

    expect(click(link({ href: BLOCKED_URL }))).toBe(false);
    expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL, newTab: true }]);
  });

  it('leaves another element with a denylisted href to the background', () => {
    const button = document.createElement('button');
    button.setAttribute('href', `//${BLOCKED_HOST}/claim`);
    document.body.append(button);

    expect(click(button)).toBe(false);
    expect(sentMessages()).toEqual([
      { type: 'CHECK_NAVIGATION', url: `${window.location.protocol}//${BLOCKED_HOST}/claim` }
    ]);
  });

  it.each(['_self', '_top', '_parent', '_SELF'])('cancels a link with the %s target', (target) => {
    expect(click(link({ href: BLOCKED_URL, target }))).toBe(true);
  });

  it('cancels a download link, which the browser follows on another site', () => {
    expect(click(link({ href: BLOCKED_URL, download: 'claim.html' }))).toBe(true);
  });

  it('leaves a link in a frame to the background', () => {
    vi.stubGlobal('top', {});
    try {
      expect(click(link({ href: BLOCKED_URL }))).toBe(false);
      expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
    } finally {
      vi.stubGlobal('top', window);
    }
  });

  it('does not flag a new tab link in a frame, which only MV2, without the redirect rule, checks', () => {
    vi.stubGlobal('top', {});
    try {
      expect(click(link({ href: BLOCKED_URL, target: '_blank' }), { ctrlKey: true })).toBe(false);
      expect(sentMessages()).toEqual([{ type: 'CHECK_NAVIGATION', url: BLOCKED_URL }]);
    } finally {
      vi.stubGlobal('top', window);
    }
  });

  it('leaves the click alone once the extension context is gone', () => {
    runtime.id = undefined;

    expect(click(link({ href: BLOCKED_URL }))).toBe(false);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("answers the background's probe for a page in the tab", () => {
    const [listener] = messageListeners;
    const answer = vi.fn();

    expect(listener?.({ type: PHISHING_PAGE_PROBE }, { id: 'qbit' }, answer)).toBe(false);
    expect(answer).toHaveBeenCalledWith({ present: true });

    answer.mockClear();
    listener?.({ type: PHISHING_PAGE_PROBE }, { id: 'another-extension' }, answer);
    listener?.({ type: 'CHECK_PHISHING' }, { id: 'qbit' }, answer);
    expect(answer).not.toHaveBeenCalled();
  });

  it('does not listen for beforeunload, which cannot block a navigation', () => {
    const windowListeners = vi.spyOn(window, 'addEventListener').mockImplementation(() => undefined);
    const documentListeners = vi.spyOn(document, 'addEventListener').mockImplementation(() => undefined);

    setupNavigationListeners();

    expect([...windowListeners.mock.calls, ...documentListeners.mock.calls].map(([type]) => type)).toEqual([
      'click',
      'pagehide'
    ]);
    windowListeners.mockRestore();
    documentListeners.mockRestore();
  });

  // Last, as the content script never forgets a host the user proceeded to.
  it('leaves later links to a host the background let through to the browser', () => {
    const proceededUrl = `https://${OTHER_BLOCKED_HOST}/claim`;
    respond = () => ({ isPhishing: false, redirected: false });
    expect(click(link({ href: proceededUrl }))).toBe(true);
    expect(followedLinks()).toHaveLength(1);

    expect(click(link({ href: `https://${OTHER_BLOCKED_HOST}/next` }))).toBe(false);
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    // Only that host: the background decides for its subdomains.
    expect(click(link({ href: `https://www.${OTHER_BLOCKED_HOST}/` }))).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('leaves links within a page the user proceeded to to the browser', () => {
    vi.stubGlobal('location', { ...window.location, hostname: `www.${BLOCKED_HOST}` });
    allowLinksWithinProceededPage();
    vi.stubGlobal('location', window.location);

    expect(click(link({ href: `https://www.${BLOCKED_HOST}/next` }))).toBe(false);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    // Only this page's host: the background decides for the others.
    expect(click(link({ href: `https://app.www.${BLOCKED_HOST}/` }))).toBe(true);
    expect(click(link({ href: `https://${BLOCKED_HOST}/` }))).toBe(true);
  });
});

describe('isBundledDenylistedUrl', () => {
  // The background's navigation check, without Proceed.
  const service = new PhishingService();

  it.each([
    ...BUNDLED_PHISHING_DENYLIST.flatMap((domain) => [domain, `www.${domain}`, `a.b.${domain}`]),
    `${BLOCKED_HOST}.example.com`,
    `x${BLOCKED_HOST}`,
    `${BLOCKED_HOST.split('.')[0]}`,
    'example.com',
    'qbit.org'
  ])('agrees with the background for %s', (hostname) => {
    expect(isBundledDenylistedUrl(`https://${hostname}/path`)).toBe(service.checkPhishing(hostname).isPhishing);
  });

  it.each([`ftp://${BLOCKED_HOST}/`, `ws://${BLOCKED_HOST}/`, 'not a url', `/${BLOCKED_HOST}`])(
    'ignores %s, which is not an http(s) URL on the host',
    (url) => {
      expect(isBundledDenylistedUrl(url)).toBe(false);
    }
  );
});
