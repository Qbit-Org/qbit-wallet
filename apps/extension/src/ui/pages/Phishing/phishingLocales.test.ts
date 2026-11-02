import { describe, expect, it } from 'vitest';

import en from '../../../_locales/en/messages.json';
import es from '../../../_locales/es/messages.json';
import fr from '../../../_locales/fr/messages.json';
import ja from '../../../_locales/ja/messages.json';
import ru from '../../../_locales/ru/messages.json';
import zhTW from '../../../_locales/zh_TW/messages.json';

// The warning screen shows this when the background does not lift the block
// for the host: for a name a DNR rule cannot name, and for one the denylist
// no longer covers. The text has to hold for both.
const CANNOT_OPEN: [string, Record<string, { message: string }>, string][] = [
  ['en', en, 'This site cannot be opened from the warning page.'],
  ['es', es, 'Este sitio no se puede abrir desde la página de advertencia.'],
  ['fr', fr, 'Ce site ne peut pas être ouvert depuis la page d\u0027avertissement.'],
  ['ja', ja, 'このサイトは警告ページから開くことはできません。'],
  ['ru', ru, 'Этот сайт нельзя открыть со страницы предупреждения.'],
  ['zh_TW', zhTW, '無法從警告頁面開啟此網站。']
];

describe('warning screen locale strings', () => {
  it.each(CANNOT_OPEN)('says in %s that the site cannot be opened from the warning page', (_locale, messages, text) => {
    expect(messages.continue_to_unavailable_hostname?.message).toBe(text);
  });
});
