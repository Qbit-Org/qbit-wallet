import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  type BrowserContext,
  chromium,
  type Page,
  type TestInfo,
  type Worker,
} from '@playwright/test'

import { extensionDist } from './paths'

interface ExtensionContextObserver {
  observeContext(context: BrowserContext): void
}

interface ExtensionSessionOptions {
  /** Extra Chromium switches, such as host-resolver rules for a loopback fixture. */
  browserArgs?: readonly string[]
}

interface ExtensionManifest {
  manifest_version?: number
  background?: { service_worker?: string }
}

const EXTENSION_WORKER_URL = /^chrome-extension:\/\/([a-p]{32})\//

export class ExtensionSession {
  private contextValue: BrowserContext | undefined
  private extensionIdValue?: string
  private readonly serviceWorkerLogValue: string[] = []
  private readonly observedWorkers = new WeakSet<Worker>()
  private readonly startedAt = performance.now()

  constructor(
    private readonly userDataDir: string,
    private readonly observer?: ExtensionContextObserver,
    private readonly options: ExtensionSessionOptions = {}
  ) {}

  get context(): BrowserContext {
    if (!this.contextValue) throw new Error('extension browser context has not started')
    return this.contextValue
  }

  get extensionId(): string {
    if (!this.extensionIdValue) throw new Error('extension id has not been discovered')
    return this.extensionIdValue
  }

  async start(): Promise<void> {
    if (this.contextValue) throw new Error('extension browser context is already running')
    await this.assertMv3Build()
    await mkdir(this.userDataDir, { recursive: true })

    const executablePath = process.env['QBIT_E2E_CHROMIUM_EXECUTABLE']
    const context = await chromium.launchPersistentContext(this.userDataDir, {
      ...(executablePath ? { executablePath } : {}),
      headless: false,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 420, height: 860 },
      args: [
        `--disable-extensions-except=${extensionDist}`,
        `--load-extension=${extensionDist}`,
        '--no-default-browser-check',
        '--no-first-run',
        ...(this.options.browserArgs ?? []),
      ],
    })
    this.contextValue = context
    try {
      this.observer?.observeContext(context)
      context.on('serviceworker', worker => this.observeServiceWorker(worker))
      context.serviceWorkers().forEach(worker => this.observeServiceWorker(worker))

      const worker = await this.waitForServiceWorker()
      const extensionId = this.extensionIdFromWorker(worker)
      if (this.extensionIdValue && this.extensionIdValue !== extensionId) {
        throw new Error(
          `extension id changed across browser restart: ${this.extensionIdValue} -> ${extensionId}`
        )
      }
      this.extensionIdValue = extensionId
    } catch (error) {
      try {
        await this.closeContext()
      } catch {
        // Preserve the startup error if rolling back the browser context also fails.
      }
      throw error
    }
  }

  async restart(): Promise<void> {
    await this.closeContext()
    await this.start()
  }

  async serviceWorker(): Promise<Worker> {
    return this.waitForServiceWorker()
  }

  /** Attaches the service worker's console output and lifecycle, across restarts. */
  async attachServiceWorkerLog(testInfo: TestInfo): Promise<void> {
    await testInfo.attach('extension-service-worker.log', {
      body: this.serviceWorkerLogValue.length
        ? `${this.serviceWorkerLogValue.join('\n')}\n`
        : '(no entries)\n',
      contentType: 'text/plain',
    })
  }

  async openWallet(route = '/welcome'): Promise<Page> {
    const page = await this.context.newPage()
    const hashRoute = route.startsWith('/') ? route : `/${route}`
    await page.goto(`chrome-extension://${this.extensionId}/index.html#${hashRoute}`, {
      waitUntil: 'domcontentloaded',
    })
    return page
  }

  async requestWalletController<T>(
    page: Page,
    method: string,
    params: readonly unknown[] = []
  ): Promise<T> {
    return page.evaluate(
      ({ method, params }) =>
        new Promise<T>((resolve, reject) => {
          const port = chrome.runtime.connect({ name: 'tab' })
          const ident = 1
          const timeout = window.setTimeout(() => {
            port.disconnect()
            reject(new Error(`wallet controller request timed out: ${method}`))
          }, 120_000)

          port.onMessage.addListener(message => {
            if (message?._type_ !== 'QBIT_WALLET_response' || message?.data?.ident !== ident) {
              return
            }
            window.clearTimeout(timeout)
            port.disconnect()
            if (message.data.err) {
              reject(new Error(message.data.err.message || String(message.data.err)))
              return
            }
            resolve(message.data.res as T)
          })

          port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError
            if (error) {
              window.clearTimeout(timeout)
              reject(new Error(error.message))
            }
          })

          port.postMessage({
            _type_: 'QBIT_WALLET_request',
            data: {
              ident,
              data: {
                type: 'ui_controller',
                method,
                params,
              },
            },
          })
        }),
      { method, params }
    )
  }

  async captureWalletBroadcasts(page: Page): Promise<void> {
    await page.evaluate(() => {
      const captureWindow = window as typeof window & {
        __qbitE2eWalletBroadcastMethods?: string[]
        __qbitE2eWalletBroadcastPort?: chrome.runtime.Port
      }
      captureWindow.__qbitE2eWalletBroadcastPort?.disconnect()
      captureWindow.__qbitE2eWalletBroadcastMethods = []

      const port = chrome.runtime.connect({ name: 'tab' })
      captureWindow.__qbitE2eWalletBroadcastPort = port
      port.onMessage.addListener(message => {
        const request = message?.data
        if (message?._type_ !== 'QBIT_WALLET_request' || request?.data?.type !== 'bg_broadcast') {
          return
        }

        captureWindow.__qbitE2eWalletBroadcastMethods?.push(request.data.method)
        port.postMessage({
          _type_: 'QBIT_WALLET_response',
          data: { ident: request.ident, res: null },
        })
      })
    })
  }

  async walletBroadcastMethods(page: Page): Promise<string[]> {
    return page.evaluate(
      () =>
        (window as typeof window & { __qbitE2eWalletBroadcastMethods?: string[] })
          .__qbitE2eWalletBroadcastMethods ?? []
    )
  }

  async wipeStorage(page: Page): Promise<void> {
    await page.evaluate(() => chrome.storage.local.clear())
    await this.restart()
  }

  async close(): Promise<void> {
    await this.closeContext()
  }

  private observeServiceWorker(worker: Worker): void {
    if (!EXTENSION_WORKER_URL.test(worker.url()) || this.observedWorkers.has(worker)) return
    this.observedWorkers.add(worker)
    this.recordServiceWorker('lifecycle', `started ${worker.url()}`)
    worker.on('console', message => this.recordServiceWorker(message.type(), message.text()))
    worker.on('close', () => this.recordServiceWorker('lifecycle', 'stopped'))
  }

  private recordServiceWorker(type: string, text: string): void {
    const elapsedMs = (performance.now() - this.startedAt).toFixed(2)
    this.serviceWorkerLogValue.push(`[+${elapsedMs}ms] ${type} ${text}`)
  }

  private async waitForServiceWorker(): Promise<Worker> {
    const current = this.context
      .serviceWorkers()
      .find(worker => EXTENSION_WORKER_URL.test(worker.url()))
    if (current) return current
    return this.context.waitForEvent('serviceworker', {
      predicate: worker => EXTENSION_WORKER_URL.test(worker.url()),
      timeout: 30_000,
    })
  }

  private extensionIdFromWorker(worker: Worker): string {
    const match = worker.url().match(EXTENSION_WORKER_URL)
    if (!match?.[1])
      throw new Error(`unable to parse extension id from service worker URL: ${worker.url()}`)
    return match[1]
  }

  private async assertMv3Build(): Promise<void> {
    const manifestPath = resolve(extensionDist, 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw new Error(
        `MV3 extension build is missing at ${manifestPath}; run pnpm test:e2e:build first`
      )
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ExtensionManifest
    if (manifest.manifest_version !== 3 || !manifest.background?.service_worker) {
      throw new Error(`extension build at ${manifestPath} is not an MV3 service-worker build`)
    }
  }

  private async closeContext(): Promise<void> {
    const context = this.contextValue
    this.contextValue = undefined
    if (context) await context.close()
  }
}
