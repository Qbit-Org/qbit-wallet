import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UI_CONTROLLER_METHODS,
  getUiControllerMethod,
  isExtensionPageSender,
} from '../src/controllers/ui-access'
import { WalletController } from '../src/controllers/wallet'

vi.mock('../src/services', () => ({
  keyringService: { keyrings: [] },
  preferenceService: {},
  walletApiService: {},
  sessionService: {},
  contactBookService: {},
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: { resolveApproval: vi.fn(), rejectApproval: vi.fn() },
}))

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`

function stubExtensionRuntime(runtime: Partial<typeof chrome.runtime> | undefined) {
  vi.stubGlobal('chrome', runtime === undefined ? undefined : { runtime })
}

describe('isExtensionPageSender', () => {
  beforeEach(() => {
    stubExtensionRuntime({
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [
      'the popup',
      { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/popup.html`, origin: EXTENSION_ORIGIN },
    ],
    ['the side panel', { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/sidepanel.html` }],
    [
      'a wallet tab',
      {
        id: EXTENSION_ID,
        url: `${EXTENSION_ORIGIN}/index.html#/main`,
        tab: { id: 4 } as chrome.tabs.Tab,
        frameId: 0,
      },
    ],
    [
      'the phishing warning page',
      {
        id: EXTENSION_ID,
        url: `${EXTENSION_ORIGIN}/index.html#/phishing?hostname=evil.example`,
        origin: EXTENSION_ORIGIN,
        tab: { id: 4 } as chrome.tabs.Tab,
      },
    ],
  ])('accepts %s', (_label, sender: chrome.runtime.MessageSender) => {
    expect(isExtensionPageSender(sender)).toBe(true)
  })

  it.each([
    [
      'a content script on a web page',
      {
        id: EXTENSION_ID,
        url: 'https://evil.example/',
        origin: 'https://evil.example',
        frameId: 0,
      },
    ],
    ['a content script without an origin', { id: EXTENSION_ID, url: 'http://127.0.0.1:33735/' }],
    [
      'a wallet page framed by a web page',
      {
        id: EXTENSION_ID,
        url: `${EXTENSION_ORIGIN}/index.html#/phishing?hostname=evil.example`,
        origin: EXTENSION_ORIGIN,
        tab: { id: 4 } as chrome.tabs.Tab,
        frameId: 3,
      },
    ],
    ['another extension', { id: 'other', url: 'chrome-extension://other/index.html' }],
    [
      'another extension naming a wallet URL',
      { id: 'other', url: `${EXTENSION_ORIGIN}/index.html` },
    ],
    ['no extension id', { url: `${EXTENSION_ORIGIN}/index.html` }],
    [
      'a frame origin that disagrees with the URL',
      { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/index.html`, origin: 'https://evil.example' },
    ],
    [
      'an opaque frame origin',
      { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/index.html`, origin: 'null' },
    ],
    ['the wallet host under another scheme', { id: EXTENSION_ID, url: `https://${EXTENSION_ID}/` }],
    [
      'a look-alike host',
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}.evil.example/index.html` },
    ],
    ['about:blank', { id: EXTENSION_ID, url: 'about:blank', origin: 'null' }],
    ['a data: URL', { id: EXTENSION_ID, url: 'data:text/html,hi' }],
    ['a malformed URL', { id: EXTENSION_ID, url: 'not a url' }],
    ['an empty URL', { id: EXTENSION_ID, url: '' }],
    ['no URL', { id: EXTENSION_ID }],
    ['a non-string URL', { id: EXTENSION_ID, url: 42 as unknown as string }],
  ])('rejects %s', (_label, sender: chrome.runtime.MessageSender) => {
    expect(isExtensionPageSender(sender)).toBe(false)
  })

  it('rejects a missing sender', () => {
    expect(isExtensionPageSender(undefined)).toBe(false)
  })

  it('fails closed outside an extension runtime', () => {
    const sender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/index.html` }

    stubExtensionRuntime(undefined)
    expect(isExtensionPageSender(sender)).toBe(false)

    stubExtensionRuntime({ getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}` })
    expect(isExtensionPageSender({ ...sender, id: undefined })).toBe(false)

    // A runtime whose own URL has no host can never be matched.
    stubExtensionRuntime({ id: EXTENSION_ID, getURL: () => 'about:blank' })
    expect(isExtensionPageSender({ id: EXTENSION_ID, url: 'about:blank' })).toBe(false)
  })

  it('accepts a Firefox extension page, which reports no frame origin', () => {
    stubExtensionRuntime({
      id: 'wallet@qbit',
      getURL: (path: string) => `moz-extension://0d9f6a51-4f4c-4b47-9a4c-7d0b8b0c1f2e/${path}`,
    })

    expect(
      isExtensionPageSender({
        id: 'wallet@qbit',
        url: 'moz-extension://0d9f6a51-4f4c-4b47-9a4c-7d0b8b0c1f2e/popup.html',
      })
    ).toBe(true)
    expect(isExtensionPageSender({ id: 'wallet@qbit', url: 'https://evil.example/' })).toBe(false)
  })
})

describe('getUiControllerMethod', () => {
  it('resolves every allowlisted method on the real controller', () => {
    const controller = new WalletController()

    for (const method of UI_CONTROLLER_METHODS) {
      expect(typeof getUiControllerMethod(controller, method), method).toBe('function')
    }
  })

  it('refuses every other member of the real controller, inherited ones included', () => {
    const controller = new WalletController()
    const allowed = new Set<string>(UI_CONTROLLER_METHODS)
    const refused = new Set<string>()
    for (let owner: object | null = controller; owner; owner = Object.getPrototypeOf(owner)) {
      for (const name of Object.getOwnPropertyNames(owner)) {
        if (!allowed.has(name)) refused.add(name)
      }
    }

    // Spot-check that the walk reached the members this allowlist exists to
    // keep out of reach.
    expect([...refused]).toEqual(
      expect.arrayContaining([
        'performRemoveKeyring',
        'signP2mrMessage',
        'setSite',
        'resetAllData',
        'runForUiPort',
        'emit',
        'constructor',
        'toString',
        '__proto__',
      ])
    )
    for (const name of refused) {
      expect(() => getUiControllerMethod(controller, name), name).toThrow(
        `Unknown wallet method: ${name}`
      )
    }
  })

  it.each([undefined, null, 42, {}, ['getAccounts'], ''])('refuses the method name %j', method => {
    expect(() => getUiControllerMethod(new WalletController(), method)).toThrow(
      /^Unknown wallet method/
    )
  })

  it('binds a method declared on the controller class itself', () => {
    class Controller {
      getAccounts() {
        return this
      }
    }
    const controller = new Controller()

    expect(getUiControllerMethod(controller, 'getAccounts')()).toBe(controller)
  })

  it('handles a controller without a prototype', () => {
    const controller = Object.assign(Object.create(null), { getAccounts: () => ['qb1'] })

    expect(getUiControllerMethod(controller, 'getAccounts')()).toEqual(['qb1'])
    expect(() => getUiControllerMethod(Object.create(null), 'getAccounts')).toThrow(
      'Unknown wallet method: getAccounts'
    )
  })

  it('refuses an allowlisted name the controller only inherits or does not hold as a function', () => {
    class Base {
      getAccounts() {
        return []
      }
    }
    class Derived extends Base {}

    expect(() => getUiControllerMethod(new Derived(), 'getAccounts')).toThrow(
      'Unknown wallet method: getAccounts'
    )
    expect(() => getUiControllerMethod({ getAccounts: 'not a function' }, 'getAccounts')).toThrow(
      'Unknown wallet method: getAccounts'
    )
    expect(() => getUiControllerMethod({}, 'getAccounts')).toThrow(
      'Unknown wallet method: getAccounts'
    )
  })
})

describe('UI_CONTROLLER_METHODS', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

  function sourceFiles(dir: string): string[] {
    return readdirSync(join(repoRoot, dir), { recursive: true, encoding: 'utf8' })
      .filter(file => /\.tsx?$/.test(file) && !/(^|\/)node_modules\//.test(file))
      .map(file => join(repoRoot, dir, file))
  }

  function collect(files: string[], pattern: RegExp): Map<string, string> {
    const found = new Map<string, string>()
    for (const file of files) {
      for (const [, method] of readFileSync(file, 'utf8').matchAll(pattern)) {
        if (method && !found.has(method)) found.set(method, relative(repoRoot, file))
      }
    }
    return found
  }

  const uiSources = (dir: string) => sourceFiles(dir).filter(file => !/\.test\.tsx?$/.test(file))
  // Every `wallet.<method>` the UI calls goes to the controller through the
  // proxy in apps/extension/src/ui/web/ui-messaging.ts, except
  // `requestMethod`, which the proxy routes to the development-only
  // provider path. The lookbehind skips paths such as `qbit-wallet.svg`.
  const WALLET_CALL = /(?<![\w$\-/])(?:wallet|useWallet\(\))\s*\??\.\s*([A-Za-z_$][\w$]*)/g
  // Computed access, destructuring and aliasing hide the method name from
  // WALLET_CALL; UI code has to stay with `wallet.<method>`.
  const OPAQUE_ACCESS =
    /(\bwallet\s*\??\.?\s*\[|\{[^{}]*\}\s*=\s*(?:await\s+)?(?:wallet|useWallet\(\))(?![\w$.(])|=\s*wallet\s*[;,)\n])/g
  const walletCalls = (dir: string) => collect(uiSources(dir), WALLET_CALL)
  const extensionUiCalls = walletCalls('apps/extension/src/ui')
  const walletStateCalls = walletCalls('packages/wallet-state/src')
  const uiCalls = new Map([...walletStateCalls, ...extensionUiCalls])
  uiCalls.delete('requestMethod')
  const e2eCalls = collect(
    sourceFiles('tests/e2e'),
    /requestWalletController\s*(?:<[^>]*>)?\s*\(\s*[^,()]+,\s*['"`]([A-Za-z_$][\w$]*)['"`]/g
  )

  it('scans the sources it is meant to', () => {
    expect(uiCalls.size).toBeGreaterThan(100)
    expect(extensionUiCalls.has('getBackgroundInited')).toBe(true)
    expect(walletStateCalls.has('signPsbtV2')).toBe(true)
    expect(e2eCalls.size).toBeGreaterThan(10)
    expect(e2eCalls.has('getQbitUtxos')).toBe(true)
  })

  it('recognises the call forms it scans for and the ones it cannot name', () => {
    const names = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map(m => m[1])

    expect(
      names(
        "await wallet.getAccounts(); props.wallet?.lockWallet(); useWallet()\n  .isUnlocked(); '/qbit-wallet.svg'",
        WALLET_CALL
      )
    ).toEqual(['getAccounts', 'lockWallet', 'isUnlocked'])
    expect(
      names(
        'wallet[name](); const { unlock } = wallet\nconst { boot } = useWallet();const w = wallet;',
        OPAQUE_ACCESS
      )
    ).toHaveLength(4)
    expect(names('const wallet = useWallet(); useWalletKeepalive(wallet)', OPAQUE_ACCESS)).toEqual(
      []
    )
  })

  it('finds no controller access the scan cannot name', () => {
    const opaque = collect(
      [...uiSources('apps/extension/src/ui'), ...uiSources('packages/wallet-state/src')],
      OPAQUE_ACCESS
    )

    expect([...opaque].map(([access, file]) => `${access} (${file})`)).toEqual([])
  })

  it('covers every controller method the UI and the e2e harness call', () => {
    const allowed = new Set<string>(UI_CONTROLLER_METHODS)
    const missing = [...uiCalls, ...e2eCalls]
      .filter(([method]) => !allowed.has(method))
      .map(([method, file]) => `${method} (${file})`)

    expect(missing).toEqual([])
  })

  it('lists nothing the UI and the e2e harness no longer call', () => {
    const stale = UI_CONTROLLER_METHODS.filter(
      method => !uiCalls.has(method) && !e2eCalls.has(method)
    )

    expect(stale).toEqual([])
  })

  it('has no duplicates', () => {
    expect(new Set(UI_CONTROLLER_METHODS).size).toBe(UI_CONTROLLER_METHODS.length)
  })
})
