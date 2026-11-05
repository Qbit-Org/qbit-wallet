import { mkdir } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { SendPage } from '../e2e/pages'
import { expect, test as base } from '../e2e/fixtures/test'
import { ExtensionSession } from '../e2e/support/extension-session'
import {
  provisionDeterministicRegtestWallet,
  waitForWalletTransactions,
} from '../e2e/support/wallet-setup'

/**
 * A large transaction whose upload takes longer than 1.0.7's fixed 15 s
 * broadcast budget still lands (#146). A proxy in front of the regtest
 * explorer holds each submission (POST /tx) for the time its hex would take
 * to go out over a slow uplink before passing it on, so the wallet waits
 * exactly as it would on that link.
 *
 * The hold is 15 s plus half of the upload allowance 1.0.8 adds (the body at
 * 16 KiB/s): past the old budget, inside the new one.
 */

const MIN_UPLOAD_BYTES_PER_SECOND = 16 * 1024
const REPLY_BUDGET_MS = 15_000
const INPUTS = 24

interface Submission {
  bytes: number
  heldMs: number
  status?: number | undefined
}

class SlowUplinkProxy {
  private server: Server | undefined
  url = ''
  readonly submissions: Submission[] = []

  async start(): Promise<string> {
    const server = createServer((clientRequest, clientResponse) => {
      const target = new URL(clientRequest.url ?? '/')
      const chunks: Buffer[] = []
      clientRequest.on('data', chunk => chunks.push(chunk as Buffer))
      clientRequest.on('end', () => {
        const body = Buffer.concat(chunks)
        const isSubmission = clientRequest.method === 'POST' && target.pathname === '/tx'
        const allowanceMs = (body.length / MIN_UPLOAD_BYTES_PER_SECOND) * 1000
        const heldMs = isSubmission ? REPLY_BUDGET_MS + allowanceMs / 2 : 0
        const submission: Submission | undefined = isSubmission
          ? { bytes: body.length, heldMs }
          : undefined
        if (submission) this.submissions.push(submission)
        setTimeout(() => {
          const upstream = httpRequest(
            target,
            {
              method: clientRequest.method,
              headers: { ...clientRequest.headers, host: target.host },
            },
            upstreamResponse => {
              if (submission) submission.status = upstreamResponse.statusCode
              clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
              upstreamResponse.pipe(clientResponse)
            }
          )
          upstream.on('error', () => {
            if (!clientResponse.headersSent) clientResponse.writeHead(502)
            clientResponse.end()
          })
          upstream.end(body)
        }, heldMs)
      })
    })
    // HTTPS goes nowhere in this run.
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return this.url
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const test = base.extend<{ uplink: SlowUplinkProxy }>({
  uplink: async ({}, use) => {
    const proxy = new SlowUplinkProxy()
    await proxy.start()
    try {
      await use(proxy)
    } finally {
      await proxy.close()
    }
  },
  extension: async ({ diagnostics, regtest, uplink }, use, testInfo) => {
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const proxyUrl = uplink.url
    const extension = new ExtensionSession(userDataDir, diagnostics, {
      // Loopback normally bypasses a proxy; <-loopback> sends it through.
      browserArgs: [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>'],
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        await diagnostics.finalize(testInfo, extension, regtest)
      } finally {
        await extension.close()
      }
    }
  },
})

test(`a ${INPUTS}-input send whose upload outlasts 1.0.7's 15 s budget is broadcast, not left unknown`, async ({
  extension,
  regtest,
  uplink,
}) => {
  test.setTimeout(20 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  // Funding 24 outputs can outlast the default 3-minute auto-lock on a busy host.
  await extension.requestWalletController(setup.page, 'setAutoLockTimeId', [6])
  const fundings: string[] = []
  for (let index = 0; index < INPUTS; index += 1)
    fundings.push(await regtest.fund(setup.address, '0.0002'))
  await waitForWalletTransactions(extension, setup.page, fundings)

  await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/main`, {
    waitUntil: 'domcontentloaded',
  })
  await setup.home.waitUntilReady()
  await setup.home.openSend()
  const send = new SendPage(setup.page)
  // The whole balance (MAX), so the send spends every input.
  await send.enterTransfer(setup.temporaryAddress, '0.0001')
  await send.chooseFeeRateOption(0)
  await setup.page.getByText('MAX', { exact: true }).click()
  await expect.poll(() => send.estimatedInputCount(), { timeout: 60_000 }).toBe(INPUTS)
  await send.continueToReview()
  const { transactionId } = await send.signAndBroadcast()

  expect(uplink.submissions.length, 'the explorer saw the submission').toBeGreaterThan(0)
  const [first] = uplink.submissions
  console.log(
    `submission: ${first!.bytes} bytes of hex, held ${(first!.heldMs / 1000).toFixed(1)} s (1.0.7 budget 15 s; 1.0.8 budget ${((REPLY_BUDGET_MS + (first!.bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000) / 1000).toFixed(1)} s), status ${first!.status}`
  )
  // The hold really was past the old budget, with room to spare.
  expect(first!.heldMs).toBeGreaterThan(REPLY_BUDGET_MS + 3_000)
  regtest.trackTransaction(transactionId)
  await regtest.waitForMempoolTransaction(transactionId)

  // The success screen, not the unknown-outcome one, and back home.
  await send.finishSuccess()
})
