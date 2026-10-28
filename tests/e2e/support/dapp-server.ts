import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Qbit G3 Provider Fixture</title>
  </head>
  <body>
    <main data-testid="qbit-dapp-fixture">Qbit G3 Provider Fixture</main>
  </body>
</html>`

export class DappServer {
  private serverValue: Server | undefined
  private originValue: string | undefined

  get origin(): string {
    if (!this.originValue) throw new Error('dapp fixture server has not started')
    return this.originValue
  }

  async start(): Promise<string> {
    if (this.serverValue) throw new Error('dapp fixture server is already running')
    const server = createServer((request, response) => {
      if (request.url !== '/') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(FIXTURE_HTML)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address) {
      server.close()
      throw new Error('dapp fixture server did not expose a listening address')
    }
    this.serverValue = server
    this.originValue = `http://127.0.0.1:${address.port}`
    return this.originValue
  }

  async close(): Promise<void> {
    const server = this.serverValue
    this.serverValue = undefined
    this.originValue = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
}
