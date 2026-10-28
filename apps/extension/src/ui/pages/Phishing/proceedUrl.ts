import { normalizeHostname } from '@qbit/phishing-detect';

/**
 * Where Proceed navigates: the blocked URL when it is an http(s) URL on the
 * warned host, otherwise that host's HTTPS root. The warning page's query is
 * not trusted to name another site or a script URL.
 */
export function getProceedUrl(href: string | null, hostname: string): string {
  if (href) {
    try {
      const url = new URL(href);
      const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
      if (isWeb && normalizeHostname(url.hostname) === normalizeHostname(hostname)) {
        return url.href;
      }
    } catch {
      // Fall back to the host's root below.
    }
  }
  return `https://${hostname}/`;
}
