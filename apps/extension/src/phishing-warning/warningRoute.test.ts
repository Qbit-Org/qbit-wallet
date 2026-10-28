import { describe, expect, it } from 'vitest';

import { MAX_BLOCKED_URL_LENGTH, phishingWarningPath } from './warningRoute';

const NOW = 1_700_000_000_000;

function warningQuery(path: string): Record<string, string> | undefined {
  const [screen, query] = path.split('?');
  expect(screen).toBe('index.html#/phishing');
  return query === undefined ? undefined : Object.fromEntries(new URLSearchParams(query));
}

describe('phishingWarningPath', () => {
  it.each([
    ['#http://phish.example/claim?ref=1', 'phish.example', 'http://phish.example/claim?ref=1'],
    ['#https://a.phish.example:8443/x', 'a.phish.example', 'https://a.phish.example:8443/x'],
    ['#https://PHISH.example', 'phish.example', 'https://phish.example/'],
    // As the browser serializes the fragment of the redirect target.
    ['#https://phish.example/a%20b?q=%3Cx%3E', 'phish.example', 'https://phish.example/a%20b?q=%3Cx%3E'],
    ['#https://xn--n3h.example/', 'xn--n3h.example', 'https://xn--n3h.example/']
  ])('sends %s to the warning for its host', (fragment, hostname, href) => {
    expect(warningQuery(phishingWarningPath(fragment, NOW))).toEqual({ hostname, href, timestamp: String(NOW) });
  });

  it('keeps a URL that fills the length bound', () => {
    const prefix = 'https://phish.example/';
    const href = prefix + 'a'.repeat(MAX_BLOCKED_URL_LENGTH - prefix.length);
    expect(warningQuery(phishingWarningPath(`#${href}`, NOW))?.['href']).toBe(href);
  });

  it('passes on only the origin of a URL past the length bound', () => {
    const href = `http://phish.example:8080/${'a'.repeat(MAX_BLOCKED_URL_LENGTH)}`;
    expect(warningQuery(phishingWarningPath(`#${href}`, NOW))).toEqual({
      hostname: 'phish.example',
      href: 'http://phish.example:8080/',
      timestamp: String(NOW)
    });
  });

  it('bounds the URL as parsed, which can be longer than the fragment', () => {
    // Each space becomes `%20` once parsed.
    const blocked = `https://phish.example/${' '.repeat(MAX_BLOCKED_URL_LENGTH / 2)}x`;
    expect(blocked.length).toBeLessThan(MAX_BLOCKED_URL_LENGTH);
    expect(warningQuery(phishingWarningPath(`#${blocked}`, NOW))?.['href']).toBe('https://phish.example/');
  });

  it.each([
    ['no fragment', ''],
    ['an empty fragment', '#'],
    ['a malformed URL', '#not a url'],
    ['a relative path', '#/claim'],
    // eslint-disable-next-line no-script-url -- the input under test
    ['a script URL', '#javascript:alert(1)'],
    // eslint-disable-next-line no-script-url -- the input under test
    ['a script URL split by a newline', '#java\nscript:alert(1)'],
    ['a data URL', '#data:text/html,<p>hi</p>'],
    ['a file URL', '#file:///etc/passwd'],
    ['an extension URL', '#chrome-extension://abc/index.html'],
    ['a browser page', '#chrome://settings'],
    ['an FTP URL', '#ftp://phish.example/'],
    ['a host longer than DNS allows', `#https://${'a'.repeat(250)}.example/`]
  ])('shows the warning without a site for %s', (_label, fragment) => {
    expect(phishingWarningPath(fragment, NOW)).toBe('index.html#/phishing');
  });
});
