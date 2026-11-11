import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { qbitFeeWarningText } from '../../../packages/wallet-state/src/utils/qbit-fee-warning-text';
import { i18nService } from '../src/shared/utils/i18n';

const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/_locales');

function localeMessages(locale: string): Record<string, { message: string }> {
  return JSON.parse(readFileSync(resolve(localesDir, locale, 'messages.json'), 'utf8'));
}

// What each locale shows: the notice for the 1 bit/vB rate the fee bar uses
// without estimates, the warning for a rate of 100 bits/vB, 400 times the
// 0.25 bits/vB relay floor, and why a Custom rate below that floor is refused.
const EXPECTED = {
  en: {
    notice: "Fee estimates are unavailable. Using the wallet's default rate of 1 bit/vB.",
    warning: '100 bits/vB is 400× the network minimum of 0.25 bits/vB.',
    minimum: 'The minimum fee rate is 0.25 bits/vB.'
  },
  es: {
    notice:
      'Las estimaciones de tarifas no están disponibles. Se usa la tasa predeterminada de la billetera, 1 bit/vB.',
    warning: '100 bits/vB es 400× el mínimo de la red de 0.25 bits/vB.',
    minimum: 'La tasa de tarifa mínima es de 0.25 bits/vB.'
  },
  fr: {
    notice: 'Les estimations de frais sont indisponibles. Le taux par défaut du portefeuille, 1 bit/vB, est utilisé.',
    warning: '100 bits/vB représente 400× le minimum du réseau de 0.25 bit/vB.',
    minimum: 'Le taux de frais minimum est de 0.25 bit/vB.'
  },
  ja: {
    notice: '手数料の見積もりを利用できません。ウォレットの既定の手数料率 1 bit/vB を使用しています。',
    warning: '100 bits/vB は、ネットワーク最小値 0.25 bit/vB の 400 倍です。',
    minimum: '手数料率の最小値は 0.25 bit/vB です。'
  },
  ru: {
    notice: 'Оценки комиссии недоступны. Используется ставка кошелька по умолчанию: 1 бит/vB.',
    warning: '100 бит/vB — это 400× от минимума сети 0.25 бит/vB.',
    minimum: 'Минимальная ставка комиссии — 0.25 бит/vB.'
  },
  zh_TW: {
    notice: '目前無法取得手續費估算，將使用錢包的預設費率 1 bit/vB。',
    warning: '100 bits/vB 是網路最低費率 0.25 bit/vB 的 400 倍。',
    minimum: '最低費率為 0.25 bit/vB。'
  }
} as const;

const LOCALES = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

/** Serves each locale's messages from the source tree, as the extension serves them. */
function stubLocaleFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const locale = /_locales\/([^/]+)\/messages\.json$/.exec(url)?.[1];
      if (!locale) throw new Error(`unexpected fetch of ${url}`);
      return { json: async () => localeMessages(locale) };
    })
  );
}

describe('fee rate messages in every locale (#182)', () => {
  // The language before each test, which the test may change.
  let localeBefore: string;

  beforeAll(async () => {
    stubLocaleFetch();
    try {
      await i18nService.init({
        storage: { get: async () => 'en', set: async () => undefined } as any
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  beforeEach(() => {
    stubLocaleFetch();
    localeBefore = i18nService.getCurrentLocale();
  });

  // Each test leaves the language and fetch as it found them.
  afterEach(async () => {
    try {
      await i18nService.changeLanguage(localeBefore);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(LOCALES)('%s names the fallback rate as the wallet’s default, not the relay floor', async (locale) => {
    const messages = localeMessages(locale);
    expect(messages).not.toHaveProperty('fee_estimates_unavailable_using_floor');
    expect(messages.fee_estimates_unavailable_using_default.message.match(/\$\d/g)).toEqual(['$1']);

    await i18nService.changeLanguage(locale);
    // As the fee bar fills it: String(fallbackFeeRate).
    expect(i18nService.translate('fee_estimates_unavailable_using_default', ['1'])).toBe(EXPECTED[locale].notice);
  });

  it('has one key set in every locale', () => {
    const keys = (locale: string) => Object.keys(localeMessages(locale)).sort();
    for (const locale of LOCALES) {
      expect(keys(locale)).toEqual(keys('en'));
    }
  });

  it.each(LOCALES)('%s says the minimum fee rate is 0.25 bits/vB, its one placeholder', async (locale) => {
    expect(localeMessages(locale).fee_rate_below_minimum.message.match(/\$\d/g)).toEqual(['$1']);

    await i18nService.changeLanguage(locale);
    // As the send and consolidation screens fill it: String(QBIT_MIN_RELAY_FEE_RATE).
    expect(i18nService.translate('fee_rate_below_minimum', ['0.25'])).toBe(EXPECTED[locale].minimum);
  });

  it.each(LOCALES)('%s gives 100 bits/vB as 400 times the 0.25 bits/vB network minimum', async (locale) => {
    await i18nService.changeLanguage(locale);

    const text = qbitFeeWarningText(
      { fee: 381_700, feeRate: 100, amount: 10_000_000, reasons: ['above_relay_floor'] },
      i18nService.translate,
      'QBT'
    );

    expect(text.lines).toEqual([EXPECTED[locale].warning]);
  });
});
