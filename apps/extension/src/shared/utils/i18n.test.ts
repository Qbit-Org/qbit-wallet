import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { i18nService } from './i18n';

const MESSAGES = {
  last_error: { message: 'Last error: $1' },
  two_values: { message: '$1 then $2' }
};

describe('i18nService.translate', () => {
  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => MESSAGES }))
    );
    await i18nService.init({
      storage: { get: async () => 'en', set: async () => undefined } as any
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['rule $& failed', "rule $' failed", 'rule $` failed', 'rule $$ failed', 'rule $1 failed'])(
    'inserts %s as it is, without expanding replacement patterns',
    (text) => {
      expect(i18nService.translate('last_error', [text])).toBe(`Last error: ${text}`);
      expect(i18nService.translate('last_error', text)).toBe(`Last error: ${text}`);
    }
  );

  it('fills each placeholder in turn', () => {
    expect(i18nService.translate('two_values', ['a $& b', "c $' d"])).toBe("a $& b then c $' d");
  });

  it('does not read a value inserted for one placeholder as another', () => {
    expect(i18nService.translate('two_values', ['cost $2', 'x'])).toBe('cost $2 then x');
  });

  it('leaves a placeholder without a value in place', () => {
    expect(i18nService.translate('two_values', ['a'])).toBe('a then $2');
  });
});
