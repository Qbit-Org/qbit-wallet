import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  TestInfo,
  Worker,
} from '@playwright/test'

import type { ExtensionSession } from './extension-session'
import { repositoryRoot } from './paths'
import type { RegtestController } from './regtest'

const REPOSITORY_CHAIN_ENDPOINTS = [
  ['http://127.0.0.1:3002/', 'regtest explorer'],
  ['https://mempool.qbit.org/api', 'mainnet explorer'],
  ['https://mempool-testnet.qbit.org/api', 'Testnet4 explorer'],
] as const
const RUN_TIMINGS_PATH = resolve(repositoryRoot, 'test-results/playwright/pqc-sign-durations.jsonl')
// The unsupported centralized wallet API served every route under a /v5/ path
// segment (e.g. /v5/utxo/assets-by-outpoints). No configured qbit explorer
// exposes that surface, so any such request is a regression to an unsupported
// integration and must fail the audit even on an allowlisted explorer origin.
const UNSUPPORTED_WALLET_API_PATH_SEGMENT = /(?:^|\/)v5(?:\/|$)/

interface ConsoleLogEntry {
  elapsedMs: number
  location: string
  pageUrl: string | null
  text: string
  type: string
}

interface NetworkLogEntry {
  elapsedMs: number
  failure?: string
  frameUrl: string | null
  method: string
  resourceType: string
  status?: number
  url: string
}

interface AllowedEndpoint {
  kind: 'chain' | 'fixture'
  prefix: string
  source: string
  url: URL
}

export interface NetworkAuditViolation {
  method: string
  resourceType: string
  url: string
}

export interface PqcSignMetric {
  accountId?: string
  durationMs: number
  inputCount?: number
  operation: string
  transactionId?: string
}

export class NetworkAudit {
  private readonly allowedEndpoints: AllowedEndpoint[] = []
  private readonly violationsValue: NetworkAuditViolation[] = []

  constructor() {
    REPOSITORY_CHAIN_ENDPOINTS.forEach(([endpoint, source]) =>
      this.allowEndpoint(endpoint, 'chain', source)
    )
    const configuredRegtest = process.env['QBIT_REGTEST_ELECTRS_HTTP_URL']
    if (configuredRegtest) this.allowEndpoint(configuredRegtest, 'chain', 'environment regtest')
    ;(process.env['QBIT_E2E_ALLOWED_NETWORK_ENDPOINTS'] || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(endpoint => this.allowEndpoint(endpoint, 'chain', 'environment'))
  }

  get violations(): readonly NetworkAuditViolation[] {
    return this.violationsValue
  }

  allowFixtureOrigin(origin: string): void {
    const url = new URL(origin)
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    ) {
      throw new Error(`e2e fixture origins must be loopback HTTP URLs, got ${origin}`)
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`e2e fixture origin must not contain a path, query, or hash: ${origin}`)
    }
    this.allowEndpoint(url.href, 'fixture', 'test fixture')
  }

  inspect(request: Request): void {
    const url = new URL(request.url())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (
      !UNSUPPORTED_WALLET_API_PATH_SEGMENT.test(url.pathname) &&
      this.allowedEndpoints.some(endpoint => this.matches(endpoint.url, url))
    )
      return
    this.violationsValue.push({
      method: request.method(),
      resourceType: request.resourceType(),
      url: url.href,
    })
  }

  report(): object {
    return {
      allowedEndpoints: this.allowedEndpoints.map(({ kind, prefix, source }) => ({
        kind,
        prefix,
        source,
      })),
      violations: this.violationsValue,
    }
  }

  private allowEndpoint(value: string, kind: AllowedEndpoint['kind'], source: string): void {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`network audit endpoint must use HTTP(S), got ${value}`)
    }
    url.hash = ''
    url.search = ''
    this.allowedEndpoints.push({ kind, prefix: url.href, source, url })
  }

  private matches(allowed: URL, candidate: URL): boolean {
    if (allowed.origin !== candidate.origin) return false
    const basePath = allowed.pathname.replace(/\/+$/, '')
    if (!basePath) return true
    const candidatePath = candidate.pathname.replace(/\/+$/, '')
    return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`)
  }
}

export class PqcSignMetrics {
  private readonly metricsValue: PqcSignMetric[] = []

  get metrics(): readonly PqcSignMetric[] {
    return this.metricsValue
  }

  record(metric: PqcSignMetric): void {
    if (!metric.operation.trim()) throw new Error('PQC timing operation must not be empty')
    if (!Number.isFinite(metric.durationMs) || metric.durationMs <= 0) {
      throw new Error(`PQC timing duration must be positive, got ${metric.durationMs}`)
    }
    if (
      metric.inputCount !== undefined &&
      (!Number.isSafeInteger(metric.inputCount) || metric.inputCount < 1)
    ) {
      throw new Error(`PQC timing input count must be a positive integer, got ${metric.inputCount}`)
    }
    this.metricsValue.push({
      ...metric,
      durationMs: Math.round(metric.durationMs * 100) / 100,
    })
  }
}

export class E2eDiagnostics {
  readonly networkAudit = new NetworkAudit()
  readonly pqcMetrics = new PqcSignMetrics()

  private readonly consoleEntries: ConsoleLogEntry[] = []
  private readonly serviceWorkerEntries: ConsoleLogEntry[] = []
  private readonly networkEntries: NetworkLogEntry[] = []
  private readonly networkByRequest = new WeakMap<Request, NetworkLogEntry>()
  private readonly observedPages = new WeakSet<Page>()
  private readonly observedWorkers = new WeakSet<Worker>()
  private readonly startedAt = performance.now()

  observeContext(context: BrowserContext): void {
    context.on('console', message => this.recordConsole(message))
    context.on('page', page => this.observePage(page))
    context.on('serviceworker', worker => this.observeWorker(worker))
    context.on('request', request => this.recordRequest(request))
    context.on('requestfinished', request => void this.finishRequest(request))
    context.on('requestfailed', request => this.failRequest(request))
    context.pages().forEach(page => this.observePage(page))
    context.serviceWorkers().forEach(worker => this.observeWorker(worker))
  }

  async finalize(
    testInfo: TestInfo,
    extension: ExtensionSession,
    regtest: RegtestController
  ): Promise<void> {
    const pqcReport = {
      file: testInfo.file,
      retry: testInfo.retry,
      testId: testInfo.testId,
      title: testInfo.title,
      metrics: this.pqcMetrics.metrics,
    }
    await this.attachJson(testInfo, 'pqc-sign-durations.json', pqcReport)
    if (this.pqcMetrics.metrics.length > 0) {
      await mkdir(resolve(RUN_TIMINGS_PATH, '..'), { recursive: true })
      await appendFile(RUN_TIMINGS_PATH, `${JSON.stringify(pqcReport)}\n`, 'utf8')
    }

    await this.attachJson(testInfo, 'network-audit.json', this.networkAudit.report())

    const failed = testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus
    const auditFailed = this.networkAudit.violations.length > 0
    if (failed || auditFailed) {
      const snapshot = await regtest.snapshot().catch(error => ({
        error: error instanceof Error ? error.message : String(error),
        trackedTransactionIds: [...regtest.trackedTransactionIds],
        trackedAccountIds: [...regtest.trackedAccountIds],
      }))
      await Promise.all([
        this.attachText(testInfo, 'page-console.log', this.formatConsole(this.consoleEntries)),
        this.attachText(
          testInfo,
          'extension-service-worker.log',
          this.formatConsole(this.serviceWorkerEntries)
        ),
        this.attachJson(testInfo, 'network-requests.json', this.networkEntries),
        this.attachJson(testInfo, 'regtest-state.json', snapshot),
        this.attachJson(testInfo, 'failing-identifiers.json', {
          extensionId: extension.extensionId,
          trackedAccountIds: [...regtest.trackedAccountIds],
          trackedTransactionIds: [...regtest.trackedTransactionIds],
        }),
      ])
    }

    if (auditFailed) {
      const summary = this.networkAudit.violations
        .map(violation => `${violation.method} ${violation.url}`)
        .join('\n')
      throw new Error(`network audit rejected unconfigured browser request(s):\n${summary}`)
    }
  }

  private observePage(page: Page): void {
    if (this.observedPages.has(page)) return
    this.observedPages.add(page)
    page.on('pageerror', error => {
      this.consoleEntries.push({
        elapsedMs: this.elapsedMs(),
        location: '',
        pageUrl: page.url(),
        text: error.stack || error.message,
        type: 'pageerror',
      })
    })
  }

  private recordConsole(message: ConsoleMessage): void {
    const page = message.page()
    if (!page) return
    const location = message.location().url || ''
    const entry: ConsoleLogEntry = {
      elapsedMs: this.elapsedMs(),
      location,
      pageUrl: page?.url() || null,
      text: message.text(),
      type: message.type(),
    }
    this.consoleEntries.push(entry)
  }

  private observeWorker(worker: Worker): void {
    if (this.observedWorkers.has(worker)) return
    this.observedWorkers.add(worker)
    this.serviceWorkerEntries.push({
      elapsedMs: this.elapsedMs(),
      location: worker.url(),
      pageUrl: null,
      text: 'service worker attached',
      type: 'lifecycle',
    })
    worker.on('console', message => {
      this.serviceWorkerEntries.push({
        elapsedMs: this.elapsedMs(),
        location: message.location().url || worker.url(),
        pageUrl: null,
        text: message.text(),
        type: message.type(),
      })
    })
    worker.on('close', () => {
      this.serviceWorkerEntries.push({
        elapsedMs: this.elapsedMs(),
        location: worker.url(),
        pageUrl: null,
        text: 'service worker closed',
        type: 'lifecycle',
      })
    })
  }

  private recordRequest(request: Request): void {
    let frameUrl: string | null = null
    try {
      frameUrl = request.frame().url()
    } catch {
      // Service-worker initiated requests do not have an associated frame.
    }
    const entry: NetworkLogEntry = {
      elapsedMs: this.elapsedMs(),
      frameUrl,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    }
    this.networkEntries.push(entry)
    this.networkByRequest.set(request, entry)
    this.networkAudit.inspect(request)
  }

  private async finishRequest(request: Request): Promise<void> {
    const entry = this.networkByRequest.get(request)
    if (!entry) return
    const response = await request.response()
    if (response) entry.status = response.status()
  }

  private failRequest(request: Request): void {
    const entry = this.networkByRequest.get(request)
    if (!entry) return
    entry.failure = request.failure()?.errorText || 'request failed'
  }

  private elapsedMs(): number {
    return Math.round((performance.now() - this.startedAt) * 100) / 100
  }

  private formatConsole(entries: readonly ConsoleLogEntry[]): string {
    return entries
      .map(
        entry =>
          `[+${entry.elapsedMs.toFixed(2)}ms] ${entry.type} ${entry.pageUrl || entry.location || 'worker'} ${entry.text}`
      )
      .join('\n')
  }

  private async attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
    await testInfo.attach(name, {
      body: JSON.stringify(value, null, 2),
      contentType: 'application/json',
    })
  }

  private async attachText(testInfo: TestInfo, name: string, value: string): Promise<void> {
    await testInfo.attach(name, { body: value || '(no entries)\n', contentType: 'text/plain' })
  }
}
