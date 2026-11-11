type Translate = (key: string, substitutions?: string[]) => string;

const PLURAL_KEYS: Partial<Record<Intl.LDMLPluralRule, string>> = {
  one: 'account_switcher_account_count_one',
  few: 'account_switcher_account_count_few',
  many: 'account_switcher_account_count_many'
};
const OTHER_KEY = 'account_switcher_account_count_other';

function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  try {
    // The app's locale codes use an underscore (zh_TW); Intl wants a hyphen.
    return new Intl.PluralRules(locale.replace('_', '-')).select(count);
  } catch {
    return new Intl.PluralRules('en').select(count);
  }
}

/** "1 account", "3 accounts", in the plural form the locale uses for `count`. */
export function accountCountLabel(t: Translate, locale: string, count: number): string {
  return t(PLURAL_KEYS[pluralCategory(locale, count)] ?? OTHER_KEY, [String(count)]);
}
