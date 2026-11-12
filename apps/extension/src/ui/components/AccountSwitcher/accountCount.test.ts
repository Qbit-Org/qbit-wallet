import { describe, expect, it } from 'vitest';

import { accountCountLabel } from './accountCount';

const t = (key: string, substitutions?: string[]) => `${key}:${substitutions?.join(',') ?? ''}`;

describe('accountCountLabel', () => {
  it.each([
    ['en', 1, 'account_switcher_account_count_one:1'],
    ['en', 2, 'account_switcher_account_count_other:2'],
    ['en', 0, 'account_switcher_account_count_other:0'],
    ['fr', 0, 'account_switcher_account_count_one:0'],
    ['fr', 1, 'account_switcher_account_count_one:1'],
    ['es', 5, 'account_switcher_account_count_other:5'],
    ['ru', 1, 'account_switcher_account_count_one:1'],
    ['ru', 3, 'account_switcher_account_count_few:3'],
    ['ru', 5, 'account_switcher_account_count_many:5'],
    ['ru', 21, 'account_switcher_account_count_one:21'],
    ['ja', 1, 'account_switcher_account_count_other:1'],
    ['zh_TW', 2, 'account_switcher_account_count_other:2']
  ])('picks the %s form for %d', (locale, count, expected) => {
    expect(accountCountLabel(t, locale, count)).toBe(expected);
  });

  it('falls back to English rules for a locale Intl does not know', () => {
    expect(accountCountLabel(t, 'not a locale', 1)).toBe('account_switcher_account_count_one:1');
  });
});
