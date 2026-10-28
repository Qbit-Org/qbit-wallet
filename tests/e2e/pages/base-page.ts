import { expect, type Locator, type Page } from '@playwright/test'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export abstract class ExtensionPageObject {
  protected constructor(readonly page: Page) {}

  protected byTestId(testId: string): Locator {
    return this.page.getByTestId(testId)
  }

  protected async clickTestId(testId: string): Promise<void> {
    const target = this.byTestId(testId)
    await expect(target).toBeVisible()
    await target.click()
  }

  protected async waitForHashRoute(route: string): Promise<void> {
    const normalized = route.startsWith('/') ? route : `/${route}`
    await expect(this.page).toHaveURL(new RegExp(`#${escapeRegExp(normalized)}(?:$|\\?)`))
  }

  protected async requiredAttribute(locator: Locator, name: string): Promise<string> {
    await expect(locator).toHaveAttribute(name, /.+/)
    const value = await locator.getAttribute(name)
    if (!value)
      throw new Error(
        `${name} was empty on ${await locator.evaluate(element => element.outerHTML)}`
      )
    return value
  }
}
