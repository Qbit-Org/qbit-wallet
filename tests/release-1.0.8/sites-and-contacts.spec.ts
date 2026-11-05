import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { test as base, expect, type Frame, type Page } from '@playwright/test'

import { ApprovalsPage, OnboardingPage, SettingsPage, WalletHomePage } from '../e2e/pages'
import { ExtensionSession } from '../e2e/support/extension-session'
import { OFFLINE_BROWSER_ARGS } from '../e2e/support/release-storage'
import { FIXED_MNEMONIC } from '../e2e/support/wallet-setup'

/**
 * Website and contact behaviour new in 1.0.8 that needs no regtest node:
 * a site in a frame connects under its own origin (#113), a request lost
 * with the wallet's connection fails with 4900 (#149), and contact edits
 * keep the alias flag and refuse to overwrite another contact (#145).
 */

const PASSWORD = 'Qbit-Sites-Test-Only!1'
const DUPLICATE = 'Another contact already has this address on this network'

interface QbitWindow extends Window {
  qbit?: {
    requestAccounts(): Promise<string[]>
    getAccounts(): Promise<string[]>
    signMessage(text: string): Promise<unknown>
  }
}

/** An outer page that embeds a widget page from another origin, plainly and sandboxed. */
class PageServer {
  private server: Server | undefined
  origin = ''

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      const frame = url.searchParams.get('frame')
      const body =
        url.pathname === '/outer' && frame
          ? `<h1>outer site</h1><iframe id="widget" src="${frame}"></iframe><iframe id="sandboxed" sandbox="allow-scripts" src="${frame}"></iframe>`
          : url.pathname === '/frame'
            ? '<h1>embedded widget</h1>'
            : null
      response.writeHead(body === null ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body === null ? 'not found' : `<!doctype html><html><body>${body}</body></html>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return this.origin
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const test = base.extend<{ extension: ExtensionSession }>({
  extension: async ({}, use, testInfo) => {
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, undefined, {
      browserArgs: OFFLINE_BROWSER_ARGS,
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        await extension.attachServiceWorkerLog(testInfo)
      } finally {
        await extension.close()
      }
    }
  },
})

async function onboard(extension: ExtensionSession): Promise<Page> {
  const page = await extension.openWallet('/welcome')
  await new OnboardingPage(page).createNewWallet(PASSWORD)
  await new WalletHomePage(page).waitUntilReady()
  return page
}

async function frameOf(page: Page, selector: string): Promise<Frame> {
  const handle = await page.waitForSelector(selector)
  const frame = await handle.contentFrame()
  if (!frame) throw new Error(`${selector} has no frame`)
  await frame.waitForLoadState('domcontentloaded')
  return frame
}

test('a site in a frame connects under its own origin, the page around it stays unconnected, and a lost request fails with 4900', async ({
  extension,
}) => {
  const wallet = await onboard(extension)
  const account = await extension.requestWalletController<{ address: string }>(
    wallet,
    'getCurrentAccount'
  )
  const outer = new PageServer()
  const widget = new PageServer()
  try {
    const outerOrigin = await outer.start()
    const widgetOrigin = await widget.start()
    const page = await extension.context.newPage()
    await page.goto(`${outerOrigin}/outer?frame=${encodeURIComponent(`${widgetOrigin}/frame`)}`)
    const frame = await frameOf(page, '#widget')
    const sandboxed = await frameOf(page, '#sandboxed')
    await frame.waitForFunction(() => Boolean((window as QbitWindow).qbit))
    await page.waitForFunction(() => Boolean((window as QbitWindow).qbit))

    // The framed site asks to connect; the approval names the frame's origin.
    const connected = frame.evaluate(() => (window as QbitWindow).qbit!.requestAccounts())
    const approval = await ApprovalsPage.waitForNext(extension.context)
    const context = await approval.contextText()
    expect(context).toContain(widgetOrigin)
    expect(context).not.toContain(outerOrigin)
    await approval.approveConnection()
    expect(await connected).toEqual([account.address])

    const sites = await extension.requestWalletController<
      { origin: string; isConnected: boolean }[]
    >(wallet, 'getConnectedSites')
    expect(sites.map(site => site.origin)).toEqual([widgetOrigin])
    expect(await page.evaluate(() => (window as QbitWindow).qbit!.getAccounts())).toEqual([])
    expect(await frame.evaluate(() => (window as QbitWindow).qbit!.getAccounts())).toEqual([
      account.address,
    ])
    expect(await sandboxed.evaluate(() => 'qbit' in window)).toBe(false)

    // A request left waiting for approval when the wallet's service worker
    // stops loses its connection: the site sees 4900, not a user rejection.
    const pending = frame.evaluate(async () => {
      try {
        await (window as QbitWindow).qbit!.signMessage('lost with the connection')
        return { ok: true }
      } catch (error) {
        const { code, message } = error as { code?: number; message?: string }
        return { ok: false, code, message }
      }
    })
    const messageApproval = await ApprovalsPage.waitForNext(extension.context)
    await expect(messageApproval.page.getByTestId('p2mr-message-text')).toBeVisible({
      timeout: 60_000,
    })
    const cdp = await extension.context.newCDPSession(wallet)
    const { targetInfos } = (await cdp.send('Target.getTargets' as never)) as unknown as {
      targetInfos: { type: string; url: string; targetId: string }[]
    }
    const worker = targetInfos.find(
      target =>
        target.type === 'service_worker' &&
        target.url.startsWith(`chrome-extension://${extension.extensionId}/`)
    )
    expect(worker, 'the wallet service worker target').toBeTruthy()
    await cdp.send('Target.closeTarget' as never, { targetId: worker!.targetId } as never)
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: false, code: 4900 })
  } finally {
    await outer.close()
    await widget.close()
  }
})

interface ContactProbe {
  name: string
  address: string
  chain: string
  isContact: boolean
  isAlias: boolean
}

async function addContactThroughUi(
  extension: ExtensionSession,
  page: Page,
  name: string,
  address: string
) {
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/contacts`)
  await page.getByText('Add Address', { exact: true }).click()
  await page.getByPlaceholder('Enter name').fill(name)
  await page.getByPlaceholder('Enter address').fill(address)
  await page.getByText('Save', { exact: true }).click()
}

test('contact edits keep the alias flag, and neither adding nor editing can overwrite another contact', async ({
  extension,
}) => {
  const first = await onboard(extension)
  const chain = await extension.requestWalletController<string>(first, 'getChainType')
  const own = await extension.requestWalletController<{ address: string }>(
    first,
    'getCurrentAccount'
  )

  // No screen of this build writes an alias; contact books stored by earlier
  // builds hold them. Store one for the wallet's own address, as they did,
  // and restart so the contact book loads it.
  await first.evaluate(
    async ({ address, chain }) => {
      const { contactBook = {} } = await chrome.storage.local.get('contactBook')
      contactBook[`${address}_${chain}`] = {
        address,
        chain,
        name: 'Account alias',
        isAlias: true,
        isContact: false,
        sortIndex: 0,
      }
      await chrome.storage.local.set({ contactBook })
    },
    { address: own.address, chain }
  )
  await first.goto('about:blank')
  await extension.restart()
  const page = await extension.openWallet('/main')
  await new SettingsPage(page).unlock(PASSWORD)
  await new WalletHomePage(page).waitUntilReady()

  const contacts = () => extension.requestWalletController<ContactProbe[]>(page, 'listContacts')
  const entry = (address: string) =>
    extension.requestWalletController<ContactProbe | undefined>(
      page,
      'getContactByAddressAndChain',
      [address, chain]
    )
  expect(await entry(own.address)).toMatchObject({ isAlias: true, isContact: false })

  // A contact at the wallet's own address is both a contact and an alias.
  await addContactThroughUi(extension, page, 'Me', own.address)
  await expect.poll(async () => (await entry(own.address))?.isContact).toBe(true)
  expect((await entry(own.address))?.isAlias).toBe(true)

  // Renaming it through the edit screen keeps the alias flag.
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/contacts`)
  await page.getByText('Me', { exact: true }).click()
  await page.getByPlaceholder('Enter name').fill('Me renamed')
  await page.getByText('Save', { exact: true }).click()
  await expect.poll(async () => (await entry(own.address))?.name).toBe('Me renamed')
  expect(await entry(own.address)).toMatchObject({ isContact: true, isAlias: true })

  // Another contact, at the public test phrase's first address on this chain.
  const hdPath = chain === 'QBIT_MAINNET' ? "m/87'/0'/0'/0" : "m/87'/1'/0'/0"
  const other = await extension.requestWalletController<{ accounts: { address: string }[] }>(
    page,
    'createTmpKeyringWithMnemonics',
    [FIXED_MNEMONIC.join(' '), hdPath, '', 9, 1]
  )
  const otherAddress = other.accounts[0]!.address
  await addContactThroughUi(extension, page, 'Other', otherAddress)
  await expect.poll(async () => (await entry(otherAddress))?.name).toBe('Other')
  const saved = await contacts()

  // Adding a second contact at that address is refused.
  await addContactThroughUi(extension, page, 'Duplicate', otherAddress)
  await expect(page.getByText(DUPLICATE, { exact: true })).toBeVisible()
  expect(await contacts()).toEqual(saved)

  // Moving the first contact onto that address is refused too.
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/contacts`)
  await page.getByText('Me renamed', { exact: true }).click()
  await page.getByPlaceholder('Enter address').fill(otherAddress)
  await page.getByText('Save', { exact: true }).click()
  await expect(page.getByText(DUPLICATE, { exact: true })).toBeVisible()
  expect(await contacts()).toEqual(saved)
})
