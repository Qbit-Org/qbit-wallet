/**
 * Navigation interception module
 * Shows the phishing warning in place of a link to a denylisted host
 */
import { BUNDLED_PHISHING_DENYLIST, normalizeHostname } from '@qbit/phishing-detect';
import { PHISHING_PAGE_PROBE, PhishingMessageType } from '@qbit/wallet-shared';

import { isExtensionContextValid } from './detector';

type NavigationCheckResponse = { isPhishing?: unknown; redirected?: unknown } | undefined;

interface Link {
  element: Element;
  url: string;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

// Denylisted hosts this page knows the background lets through: its own after
// a proceeded verdict, and those of links it let through. That lasts for the
// session, so links to them are left to the browser. Only the exact hosts
// count, as the user's permanent whitelist does not cover subdomains.
const proceededHostnames = new Set<string>();
// How often the page has been hidden, for example on entering the
// back/forward cache when the tab moved on to the warning page.
let pageHides = 0;

/**
 * Ask the background to check a link. On a phishing verdict the background
 * sends this tab to the warning page, unless the link opens a new tab
 * (`newTab`) where the warning redirect rule shows it. The callback gets
 * undefined when the background could not be asked.
 */
function sendNavigationCheck(
  url: string,
  callback?: (response: NavigationCheckResponse) => void,
  newTab = false
): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: PhishingMessageType.CHECK_NAVIGATION,
        url,
        ...(newTab && { newTab })
      },
      (response?: NavigationCheckResponse) => {
        callback?.(chrome.runtime.lastError ? undefined : response);
      }
    );
  } catch (e) {
    console.error('[Navigation Check] Error:', e);
    callback?.(undefined);
  }
}

function linkHostname(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalizeHostname(parsed.hostname) : undefined;
  } catch {
    return undefined;
  }
}

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Whether the URL is http(s) on a host the bundled denylist covers, matched as
 * the background matches it: the listed host or one of its subdomains. The
 * background's navigation verdict uses only this list, so a URL it does not
 * cover needs no check.
 */
export function isBundledDenylistedUrl(url: string): boolean {
  const hostname = linkHostname(url);
  return !!hostname && BUNDLED_PHISHING_DENYLIST.some((domain) => isHostOrSubdomain(hostname, domain));
}

/**
 * Leaves links within this page's host to the browser. The content script
 * calls this when the background reports that the user chose Proceed for the
 * page.
 */
export function allowLinksWithinProceededPage(): void {
  const hostname = normalizeHostname(window.location.hostname);
  if (hostname) proceededHostnames.add(hostname);
}

function isProceededUrl(url: string): boolean {
  const hostname = linkHostname(url);
  return !!hostname && proceededHostnames.has(hostname);
}

/** An href resolved against the document, or undefined when it is not a URL. */
function resolveHref(href: string): string | undefined {
  try {
    return new URL(href, document.baseURI).href;
  } catch {
    return undefined;
  }
}

/**
 * The link a click activates: the nearest one around the clicked element,
 * including inside an open shadow root. An anchor without href is not a link.
 */
function findLink(e: MouseEvent): Link | undefined {
  for (const node of e.composedPath()) {
    if ((node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute('href')) {
      return { element: node, url: node.href };
    }
    if (node instanceof Element && node.namespaceURI === SVG_NAMESPACE && node.localName === 'a') {
      const href = node.getAttribute('href') ?? node.getAttributeNS(XLINK_NAMESPACE, 'href');
      if (href === null) continue;
      const url = resolveHref(href);
      return url ? { element: node, url } : undefined;
    }
  }
  return undefined;
}

/**
 * Whether the browser would follow the link in this tab's top frame. MV3
 * injects the content script there only, but MV2 into every frame, where a
 * link is left to the background. A download attribute does not matter: the
 * browser ignores it on a link to another site, and a denylisted host is
 * never this page's own site unless the user proceeded to it.
 */
function opensInThisTab(e: MouseEvent, link: Element): boolean {
  if (window !== window.top) return false;
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;

  const target = link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
  const keyword = target.trim().toLowerCase();
  return keyword === '' || keyword === '_self' || keyword === '_top' || keyword === '_parent' || target === window.name;
}

/**
 * Whether the browser opens the link in a new tab or window: a Ctrl-, Cmd- or
 * Shift-click, or the `_blank` target. Not an Alt-click, which downloads it,
 * nor a target that may name a frame of this page.
 */
function opensNewTab(e: MouseEvent, link: Element): boolean {
  if (window !== window.top || e.button !== 0 || e.altKey) return false;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return true;

  const target = link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
  return target.trim().toLowerCase() === '_blank';
}

/**
 * Follows a link the click handler cancelled, with its rel and referrer
 * policy. The click on a detached anchor reaches no listener on the page.
 */
function followLink(link: Link): void {
  const anchor = document.createElement('a');
  anchor.href = link.url;
  anchor.target = '_self';
  for (const name of ['rel', 'referrerpolicy']) {
    const value = link.element.getAttribute(name);
    if (value !== null) anchor.setAttribute(name, value);
  }
  anchor.click();
}

/**
 * Asks the background for the warning page in place of a link navigation the
 * click handler cancelled. If the background lets the host through (the user
 * chose Proceed for it this session) or cannot redirect, follows the link as
 * the browser would have; the DNR block rule still stops it unless Proceed
 * lifted it.
 */
function showWarningInstead(link: Link, pageUrl = pageAddress(), hides = pageHides, retries = 1): void {
  sendNavigationCheck(link.url, (response) => {
    // Leave a page that has moved on since the click. Its own click handler
    // may have navigated it, for example through its router, or the tab went
    // to the warning page and the user came back to this page: entering the
    // back/forward cache closes the message channel, and the callback runs
    // only once the page is shown again.
    if (pageAddress() !== pageUrl || pageHides !== hides) return;
    // A message sent while the service worker starts can be lost; ask once
    // more. If only the answer was lost, the second redirect lands on the same
    // warning, while following the link could race the first one.
    if (response === undefined && retries > 0 && isExtensionContextValid()) {
      showWarningInstead(link, pageUrl, hides, retries - 1);
      return;
    }
    if (response?.redirected === true) return;
    if (response?.isPhishing === false) {
      const hostname = linkHostname(link.url);
      if (hostname) proceededHostnames.add(hostname);
    }
    followLink(link);
  });
}

/** The URL in the href of an element that is not a link. */
function elementHref(target: EventTarget | null): string | undefined {
  const href = target instanceof Element ? target.getAttribute('href') : null;
  return href === null ? undefined : resolveHref(href);
}

/** This page's URL without its fragment, which pages change without navigating. */
function pageAddress(): string {
  return window.location.href.split('#')[0] ?? '';
}

function handleClick(e: MouseEvent): void {
  const link = findLink(e);
  // Check other elements that might trigger navigation
  const url = link?.url ?? elementHref(e.target);
  if (!url || !isBundledDenylistedUrl(url) || isProceededUrl(url)) return;

  if (link && opensInThisTab(e, link.element)) {
    // Cancel before anything else: once the event finishes dispatching, the
    // browser starts the link's own navigation. DNR blocks it, and it can win
    // over the background's redirect to the warning page (#320).
    e.preventDefault();
    showWarningInstead(link);
    return;
  }

  // A link that opens another tab or window. While the warning redirect rule
  // is in place, it shows the warning in a new tab, and the background leaves
  // this tab alone. Otherwise the block rule stops the link there, and the
  // background sends this tab to the warning page.
  sendNavigationCheck(url, undefined, !!link && opensNewTab(e, link.element));
}

/**
 * Setup navigation interception listeners
 */
export function setupNavigationListeners(): void {
  // A capture listener on the window runs before any listener the page adds
  // later, so the page cannot stop the click from reaching it.
  window.addEventListener(
    'click',
    (e) => {
      if (isExtensionContextValid()) handleClick(e);
    },
    true
  );
  window.addEventListener('pagehide', () => pageHides++, true);

  // Before it repeats a redirect to the warning page, the background asks
  // whether a page like this one, rather than Chrome's blocked page, is in
  // the tab.
  if (!isExtensionContextValid()) return;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== PHISHING_PAGE_PROBE) return false;
    sendResponse({ present: true });
    return false;
  });
}
