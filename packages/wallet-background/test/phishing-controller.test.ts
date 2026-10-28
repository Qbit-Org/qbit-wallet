import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PhishingMessageType } from '@qbit/wallet-shared'

import phishingController from '../src/controllers/phishing'

const phishingDetectService = vi.hoisted(() => ({
  addToWhitelist: vi.fn(),
  checkPhishing: vi.fn(() => ({ isPhishing: false })),
  // Treats every host but example.com as denylisted, so Proceed is accepted for
  // a well-formed one.
  isDenylisted: vi.fn((hostname: string) => hostname !== 'example.com'),
  forceUpdate: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn(() => ({ blacklist: [], whitelist: [] })),
}))

// The controller imports its services by the baseUrl path.
vi.mock('src/services', () => ({ phishingDetectService }))

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean

let onMessage: MessageListener

const warningPage: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  origin: EXTENSION_ORIGIN,
  tab: { id: 7 } as chrome.tabs.Tab,
  url: `${EXTENSION_ORIGIN}/index.html#/phishing?hostname=evil.example`,
}

const contentScript: chrome.runtime.MessageSender = {
  frameId: 0,
  id: EXTENSION_ID,
  origin: 'https://evil.example',
  tab: { id: 7 } as chrome.tabs.Tab,
  url: 'https://evil.example/',
}

function send(message: unknown, sender: chrome.runtime.MessageSender) {
  return new Promise(resolve => {
    onMessage(message, sender, resolve)
  })
}

describe('PhishingController message sender checks', () => {
  beforeAll(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: EXTENSION_ID,
        getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
        onMessage: {
          addListener: (listener: MessageListener) => {
            onMessage = listener
          },
        },
      },
    })
    phishingController.init()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lets the warning page skip protection for a host', async () => {
    await expect(
      send(
        { type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname: 'evil.example' },
        warningPage
      )
    ).resolves.toEqual({ success: true })
    expect(phishingDetectService.addToWhitelist).toHaveBeenCalledWith('evil.example')
  })

  it.each([
    ['a host outside the denylist', 'example.com'],
    ['a denylisted host outside DNS syntax', 'a_b.evil.example'],
  ])('does not lift protection for %s', async (_label, hostname) => {
    await expect(
      send({ type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname }, warningPage)
    ).resolves.toEqual({ error: 'Invalid hostname parameter' })
    expect(phishingDetectService.addToWhitelist).not.toHaveBeenCalled()
  })

  it.each([
    ['a content script', contentScript],
    ['another extension', { id: 'other', url: 'chrome-extension://other/index.html' }],
    ['a warning page framed by a web page', { ...warningPage, frameId: 2 }],
  ])('does not let %s skip protection', async (_label, sender) => {
    await expect(
      send({ type: PhishingMessageType.SKIP_PHISHING_PROTECTION, hostname: 'evil.example' }, sender)
    ).resolves.toEqual({ error: 'Unauthorized sender' })
    expect(phishingDetectService.addToWhitelist).not.toHaveBeenCalled()
  })

  it('lets an extension page force a list update', async () => {
    await expect(
      send({ type: PhishingMessageType.FORCE_UPDATE_PHISHING_LIST }, warningPage)
    ).resolves.toEqual({ success: true })
    expect(phishingDetectService.forceUpdate).toHaveBeenCalledOnce()
  })

  it('does not let a content script force a list update', async () => {
    await expect(
      send({ type: PhishingMessageType.FORCE_UPDATE_PHISHING_LIST }, contentScript)
    ).resolves.toEqual({ error: 'Unauthorized sender' })
    expect(phishingDetectService.forceUpdate).not.toHaveBeenCalled()
  })

  it.each([PhishingMessageType.ADD_TO_WHITELIST, PhishingMessageType.FORCE_RELOAD_PHISHING_LISTS])(
    'refuses the %s alias from a content script too',
    async type => {
      await expect(send({ type, hostname: 'evil.example' }, contentScript)).resolves.toEqual({
        error: 'Unauthorized sender',
      })
      expect(phishingDetectService.addToWhitelist).not.toHaveBeenCalled()
      expect(phishingDetectService.forceUpdate).not.toHaveBeenCalled()
    }
  )

  it('still answers phishing checks from content scripts', async () => {
    await expect(
      send({ type: PhishingMessageType.CHECK_PHISHING, hostname: 'evil.example' }, contentScript)
    ).resolves.toEqual({ isPhishing: false, isDenylisted: true })
    expect(phishingDetectService.checkPhishing).toHaveBeenCalledWith('evil.example')
    await expect(
      send({ type: PhishingMessageType.CHECK_PHISHING, hostname: 'example.com' }, contentScript)
    ).resolves.toEqual({ isPhishing: false, isDenylisted: false })
  })
})
