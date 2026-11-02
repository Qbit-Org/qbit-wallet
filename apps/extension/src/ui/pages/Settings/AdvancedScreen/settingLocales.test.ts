import { describe, expect, it } from 'vitest';

import { ErrorCodes, ErrorMessages } from '@qbit/wallet-shared';

import en from '../../../../_locales/en/messages.json';
import es from '../../../../_locales/es/messages.json';
import fr from '../../../../_locales/fr/messages.json';
import ja from '../../../../_locales/ja/messages.json';
import ru from '../../../../_locales/ru/messages.json';
import zhTW from '../../../../_locales/zh_TW/messages.json';

// The auto-lock time page shows this when a change of the setting failed to
// save and so did the previous value put back in its place.
describe('setting locale strings', () => {
  it('has the message for a previous value that could not be saved again in every locale', () => {
    const key = ErrorMessages[ErrorCodes.PREFERENCE_NOT_RESTORED];
    expect(key).toBe('setting_not_saved_may_have_changed');
    for (const [locale, messages] of Object.entries({ en, es, fr, ja, ru, zh_TW: zhTW })) {
      expect((messages as Record<string, { message: string }>)[key!]?.message, locale).toEqual(expect.any(String));
    }
  });
});
