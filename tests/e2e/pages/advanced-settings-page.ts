import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/** What Settings → Advanced Settings lists, top to bottom, by name. */
export type AdvancedSettingsItem = 'language' | 'addressType' | 'localRegtest'

const ITEM_TEST_IDS: Record<AdvancedSettingsItem, string> = {
  language: 'advanced-language-row',
  addressType: 'advanced-address-type-row',
  // Only in builds that put Local Regtest behind the optional permission.
  localRegtest: 'regtest-access-card',
}

/** Settings → Advanced Settings. */
export class AdvancedSettingsPage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  item(name: AdvancedSettingsItem): Locator {
    return this.byTestId(ITEM_TEST_IDS[name])
  }

  /** What the Address Type entry says of the current wallet. */
  get addressTypeValue(): Locator {
    return this.byTestId('advanced-address-type-value')
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/advanced')
    await expect(this.item('language')).toBeVisible()
    await expect(this.item('addressType')).toBeVisible()
  }

  /**
   * Everything the screen lists, in order: each child of its content, by
   * name, so an entry this page object does not know shows up as well.
   */
  async items(): Promise<string[]> {
    const testIds = await this.item('language')
      .locator('xpath=..')
      .locator(':scope > *')
      .evaluateAll(entries => entries.map(entry => entry.getAttribute('data-testid') ?? ''))
    const names = new Map(Object.entries(ITEM_TEST_IDS).map(([name, testId]) => [testId, name]))
    return testIds.map(testId => names.get(testId) ?? `unlisted entry "${testId}"`)
  }
}
