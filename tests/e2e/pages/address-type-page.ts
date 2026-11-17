import { expect, type Locator, type Page } from '@playwright/test'

import { ExtensionPageObject } from './base-page'

/** The names the Address Type screen gives the types, before each one's path. */
const ADDRESS_TYPE_NAMES = [
  'P2PKH',
  'Native Segwit (P2WPKH)',
  'Native SegWit (P2WPKH)',
  'Taproot (P2TR)',
  'Nested Segwit (P2SH-P2WPKH)',
  'Post-Quantum P2MR',
] as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Settings → Advanced Settings → Address Type. */
export class AddressTypePage extends ExtensionPageObject {
  constructor(page: Page) {
    super(page)
  }

  /**
   * Each type the screen lists, by its label: the type's name, then its path
   * for the current account in brackets.
   */
  get typeLabels(): Locator {
    const names = ADDRESS_TYPE_NAMES.map(escapeRegExp).join('|')
    return this.page.getByText(new RegExp(`^(${names}) \\(m/[0-9'/]+\\)$`))
  }

  /** The label of the type `name`. */
  typeLabel(name: (typeof ADDRESS_TYPE_NAMES)[number]): Locator {
    return this.page.getByText(new RegExp(`^${escapeRegExp(name)} \\(m/[0-9'/]+\\)$`))
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForHashRoute('/settings/address-type')
    await expect(this.typeLabels.first()).toBeVisible()
  }
}
