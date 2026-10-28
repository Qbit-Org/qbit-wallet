/**
 * The longest blocked URL this page passes on in full; for a longer one it
 * passes on only the origin, where Proceed then goes. The URL is carried on
 * into the warning page's address.
 */
export const MAX_BLOCKED_URL_LENGTH = 8192;

/** The longest hostname DNS allows. */
const MAX_HOSTNAME_LENGTH = 253;

/** The wallet's warning screen, relative to the extension root. */
const WARNING_SCREEN = 'index.html#/phishing';

/**
 * Where this page sends the tab: the wallet's warning screen for the blocked
 * URL that the phishing redirect rule put in its fragment. The fragment is
 * untrusted. Only an http(s) URL with a host is passed on, and only as the
 * warning screen's query: in full within the length bound, otherwise its
 * origin alone. Anything else gets the warning without a site, which offers no
 * Proceed. This page never navigates to the URL itself.
 */
export function phishingWarningPath(fragment: string, now = Date.now()): string {
  const blocked = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  let url: URL;
  try {
    url = new URL(blocked);
  } catch {
    return WARNING_SCREEN;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.hostname.length > MAX_HOSTNAME_LENGTH
  ) {
    return WARNING_SCREEN;
  }

  // The same query the background builds for its own redirect to the warning.
  const params = new URLSearchParams({
    hostname: url.hostname,
    href: url.href.length > MAX_BLOCKED_URL_LENGTH ? `${url.origin}/` : url.href,
    timestamp: String(now)
  });
  return `${WARNING_SCREEN}?${params}`;
}
