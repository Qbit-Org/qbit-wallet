import { describe, expect, it } from 'vitest';

import { getProceedUrl } from './proceedUrl';

describe('getProceedUrl', () => {
  it.each([
    ['https://phish.example/claim?ref=1#top', 'https://phish.example/claim?ref=1#top'],
    ['http://phish.example/claim', 'http://phish.example/claim'],
    ['https://PHISH.example:8443/a', 'https://phish.example:8443/a']
  ])('returns the blocked URL %s on the warned host', (href, expected) => {
    expect(getProceedUrl(href, 'phish.example')).toBe(expected);
  });

  it.each([
    ['no URL', null],
    ['an empty URL', ''],
    ['a malformed URL', 'not a url'],
    ['another host', 'https://example.com/claim'],
    ['a subdomain of another host', 'https://phish.example.example.com/'],
    // eslint-disable-next-line no-script-url -- the input under test
    ['a script URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<p>hi</p>'],
    ['an extension URL', 'chrome-extension://abc/index.html']
  ])('falls back to the host root for %s', (_label, href) => {
    expect(getProceedUrl(href, 'phish.example')).toBe('https://phish.example/');
  });
});
