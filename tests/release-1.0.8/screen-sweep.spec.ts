import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type TestInfo } from '@playwright/test'

import { OnboardingPage, WalletHomePage } from '../e2e/pages'
import { ExtensionSession } from '../e2e/support/extension-session'
import { extensionDist, repositoryRoot } from '../e2e/support/paths'
import { OFFLINE_BROWSER_ARGS } from '../e2e/support/release-storage'

/**
 * Opens every static screen of the wallet in every language, on 1.0.7 and on
 * the 1.0.8 build, and fails on any uncaught error, error screen or missing
 * translation that 1.0.8 shows and 1.0.7 did not. 1.0.8 removed antd and 344
 * translation strings per language (#134, #144), which unit tests cannot see
 * from the screens. A screenshot of every screen is attached for review.
 */

const RELEASES_DIR = process.env['QBIT_UPGRADE_RELEASES_DIR'] ?? ''
const TARGET_DIR = resolve(process.env['QBIT_UPGRADE_TARGET_DIR'] || extensionDist)
const PASSWORD = 'Qbit-Screen-Sweep-Test-Only!1'
const LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'] as const
// As the language screen lists them (LOCALE_NAMES in wallet-shared).
const LOCALE_NAMES: Record<(typeof LOCALES)[number], string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  ja: '日本語',
  ru: 'Русский',
  zh_TW: '中文(繁體)',
}
const AUTO_LOCK_ONE_HOUR = 6

// Static routes from apps/extension/src/ui/pages/MainRoute.tsx. Left out:
// routes with parameters, /test, and /approval, which needs a pending request.
const ROUTES = [
  '/main',
  '/discover',
  '/app',
  '/settings',
  '/account/create-hd-wallet',
  '/account/create',
  '/account/switch-account',
  '/wallet/receive',
  '/wallet/qbit-recovery-migration',
  '/wallet/tx/create',
  '/wallet/tx/consolidate',
  '/wallet/tx/confirm',
  '/wallet/tx/success',
  '/wallet/tx/fail',
  '/settings/network-type',
  '/settings/password',
  '/settings/biometric',
  '/settings/export-mnemonics',
  '/settings/export-privatekey',
  '/settings/advanced',
  '/settings/language',
  '/settings/appearance',
  '/settings/lock-time',
  '/settings/regtest-access',
  '/wallet/history',
  '/connected-sites',
  '/account/switch-keyring',
  '/account/add-keyring',
  '/settings/edit-wallet-name',
  '/account/create-readonly-wallet',
  '/settings/upgrade-notice',
  '/settings/address-type',
  '/settings/contacts',
  '/settings/contacts/edit',
  '/settings/edit-account-name',
  '/phishing',
  '/settings/about-us',
  '/account/create-watch-wallet',
] as const

interface Finding {
  locale: string
  route: string
  kind: 'page-error' | 'error-screen' | 'missing-translation' | 'console-error'
  detail: string
}

const MISSING_TRANSLATION = /Translation for key "([^"]+)" not found/

async function sweep(
  build: string,
  extensionDir: string,
  testInfo: TestInfo,
  locale: (typeof LOCALES)[number]
): Promise<Finding[]> {
  const findings: Finding[] = []
  const extension = new ExtensionSession(testInfo.outputPath(`profile-${build}`), undefined, {
    browserArgs: OFFLINE_BROWSER_ARGS,
    extensionDir,
  })
  await extension.start()
  try {
    const page = await extension.openWallet('/welcome')
    await new OnboardingPage(page).createNewWallet(PASSWORD)
    await new WalletHomePage(page).waitUntilReady()
    await extension.requestWalletController(page, 'setAutoLockTimeId', [AUTO_LOCK_ONE_HOUR])

    let where = { locale: '', route: '' }
    page.on('pageerror', error =>
      findings.push({ ...where, kind: 'page-error', detail: error.message.split('\n')[0]! })
    )
    page.on('console', message => {
      const missing = message.text().match(MISSING_TRANSLATION)
      if (missing) findings.push({ ...where, kind: 'missing-translation', detail: missing[1]! })
      else if (message.type() === 'error')
        findings.push({ ...where, kind: 'console-error', detail: message.text().slice(0, 200) })
    })

    {
      // Through the language screen, as a user does: the screens read the
      // language the page itself saved, not only the stored preference.
      where = { locale, route: '/settings/language' }
      await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/language`)
      await page.getByText(LOCALE_NAMES[locale], { exact: true }).click()
      await expect.poll(() => extension.requestWalletController(page, 'getLocale')).toBe(locale)
      await expect.poll(() => page.evaluate(() => localStorage.getItem('i18nextLng'))).toBe(locale)
      for (const route of ROUTES) {
        where = { locale, route }
        const url = `chrome-extension://${extension.extensionId}/index.html#${route}`
        try {
          // about:blank first, so each screen starts from a fresh load of the app.
          await page.goto('about:blank')
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await expect(page.locator('#root > *').first()).toBeAttached()
        } catch (error) {
          findings.push({
            ...where,
            kind: 'page-error',
            detail: `navigation: ${(error as Error).message.split('\n')[0]} (at ${page.url().replace(/^chrome-extension:\/\/[a-p]+/, '')})`,
          })
          continue
        }
        // Let the screen's first data loads render (offline, they fail fast).
        await page.waitForTimeout(1_200)
        // The error screen shows its own icon in every language.
        if (
          (await page.locator('[src*="error-boundary"], [style*="error-boundary"]').count()) > 0
        ) {
          findings.push({ ...where, kind: 'error-screen', detail: 'error screen shown' })
        }
        const name = `${build}-${locale}${route.replace(/\//g, '_')}.png`
        await page.screenshot({ path: testInfo.outputPath('screens', name) })
      }
    }
  } finally {
    await extension.close()
  }
  return findings
}

// Builds differ in minified names, extension ids, addresses and timestamps;
// compare what a finding says, not those.
function normalized(detail: string): string {
  return detail
    .split('\n')[0]!
    .replace(/chrome-extension:\/\/[a-p]{32}/g, 'EXT')
    .replace(/\b(?:qb|tq|qbrt)1[0-9a-z]{20,}/g, 'ADDRESS')
    .replace(/(?:\.\.\.|…)[0-9a-z]{6,}/g, '...')
    .replace(/QRM-[A-Z]+-[0-9A-F]+/g, 'QRM')
    .replace(/property '\w+' of '\w+'/g, 'property X of Y')
    .slice(0, 110)
}
const key = (finding: Finding) =>
  `${finding.locale} ${finding.route} ${finding.kind} ${normalized(finding.detail)}`

// One test per language, so languages run in parallel workers; each test
// sweeps 1.0.7 and 1.0.8 side by side in two browsers.
for (const locale of LOCALES) {
  test(`every screen in ${LOCALE_NAMES[locale]}: 1.0.8 adds no error over 1.0.7`, async ({}, testInfo) => {
    test.setTimeout(15 * 60_000)
    test.skip(!RELEASES_DIR, 'QBIT_UPGRADE_RELEASES_DIR is not set; see README.md')

    const baselineDir = testInfo.outputPath('v1.0.7')
    await rm(baselineDir, { recursive: true, force: true })
    await mkdir(baselineDir, { recursive: true })
    execFileSync('unzip', [
      '-q',
      join(RELEASES_DIR, 'qbit-chrome-mv3-v1.0.7.zip'),
      '-d',
      baselineDir,
    ])

    const [baseline, candidate] = await Promise.all([
      sweep('1.0.7', baselineDir, testInfo, locale),
      sweep('1.0.8', TARGET_DIR, testInfo, locale),
    ])

    const known = new Set(baseline.map(key))
    const added = [
      ...new Map(candidate.filter(f => !known.has(key(f))).map(f => [key(f), f])).values(),
    ]
    const reportPath = testInfo.outputPath(`screen-sweep-${locale}.json`)
    await writeFile(reportPath, `${JSON.stringify({ baseline, candidate, added }, null, 2)}\n`)
    await testInfo.attach(`screen-sweep-${locale}.json`, {
      path: reportPath,
      contentType: 'application/json',
    })
    console.log(
      `screen sweep ${locale}: 1.0.7 ${baseline.length} findings, 1.0.8 ${candidate.length}, new in 1.0.8 ${added.length}; screenshots in ${testInfo.outputPath('screens')} (repo ${repositoryRoot})`
    )
    expect(added, 'errors new in 1.0.8').toEqual([])
  })
}
