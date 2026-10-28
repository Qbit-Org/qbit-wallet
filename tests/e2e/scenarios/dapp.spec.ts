import { ApprovalsPage, SettingsPage } from '../pages'
import { expect, test } from '../fixtures/test'
import { DappServer } from '../support/dapp-server'
import {
  provisionDeterministicRegtestWallet,
  waitForWalletTransactions,
} from '../support/wallet-setup'

interface ProviderProof {
  address: string
  signature: string
  type: string
  version: number
}

interface BrowserQbitProvider {
  requestAccounts(): Promise<string[]>
  getAccounts(): Promise<string[]>
  signMessage(message: string): Promise<ProviderProof>
  verifyMessage(address: string, message: string, proof: ProviderProof): Promise<boolean>
  signPsbt(
    psbt: string,
    options: { chain: 'QBIT_REGTEST'; autoFinalized: boolean }
  ): Promise<string>
  pushPsbt(psbt: string): Promise<string>
}

interface WindowWithQbit extends Window {
  qbit?: BrowserQbitProvider
}

interface ToSignDataProbe {
  psbtHex: string
  toSignInputs: unknown[]
}

test('G3 dapp: connects, signs/verifies, signs a PSBT, broadcasts, and revokes', async ({
  extension,
  networkAudit,
  pqcMetrics,
  regtest,
}) => {
  test.setTimeout(5 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  const fundingTxid = await regtest.fund(setup.address, '0.005')
  await waitForWalletTransactions(extension, setup.page, [fundingTxid])

  const server = new DappServer()
  const origin = await server.start()
  networkAudit.allowFixtureOrigin(origin)
  try {
    const dapp = await extension.context.newPage()
    await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
    await dapp.waitForFunction(() => Boolean((window as WindowWithQbit).qbit))

    const connectResult = dapp.evaluate(() => {
      const provider = (window as WindowWithQbit).qbit
      if (!provider) throw new Error('window.qbit is unavailable')
      return provider.requestAccounts()
    })
    const connectApproval = await ApprovalsPage.waitForNext(extension.context)
    expect(await connectApproval.contextText()).toContain(origin)
    expect(await connectApproval.contextText()).toContain('QBIT_REGTEST')
    await connectApproval.approveConnection()
    expect(await connectResult).toEqual([setup.address])

    const message = 'Qbit G3 provider message — deterministic regtest'
    const messageResult = dapp.evaluate(message => {
      const provider = (window as WindowWithQbit).qbit
      if (!provider) throw new Error('window.qbit is unavailable')
      return provider.signMessage(message)
    }, message)
    const messageApproval = await ApprovalsPage.waitForNext(extension.context)
    expect(await messageApproval.contextText()).toContain(origin)
    const messageSign = await messageApproval.approveMessage(message)
    pqcMetrics.record({
      accountId: setup.address,
      durationMs: messageSign.durationMs,
      operation: 'dapp-message-sign',
    })
    expect(messageSign.signatureBudget).toContain('New signatures: 1')
    const proof = await messageResult
    expect(proof).toMatchObject({ address: setup.address, type: 'p2mr-message', version: 1 })
    expect(proof.signature).toMatch(/^[0-9a-f]+$/i)
    expect(
      await dapp.evaluate(
        ({ address, message, proof }) => {
          const provider = (window as WindowWithQbit).qbit
          if (!provider) throw new Error('window.qbit is unavailable')
          return provider.verifyMessage(address, message, proof)
        },
        { address: setup.address, message, proof }
      )
    ).toBe(true)

    const unsigned = await extension.requestWalletController<ToSignDataProbe>(
      setup.page,
      'createSendQbitPsbt',
      [
        {
          to: setup.temporaryAddress,
          amount: 100_000,
          feeRate: 2,
          enableRBF: true,
          memo: 'G3 provider PSBT',
        },
      ]
    )
    expect(unsigned.psbtHex).toMatch(/^[0-9a-f]+$/i)
    expect(unsigned.toSignInputs).toHaveLength(1)

    const signedResult = dapp.evaluate(async psbt => {
      const provider = (window as WindowWithQbit).qbit
      if (!provider) throw new Error('window.qbit is unavailable')
      try {
        return {
          ok: true as const,
          value: await provider.signPsbt(psbt, {
            chain: 'QBIT_REGTEST',
            autoFinalized: true,
          }),
        }
      } catch (error) {
        const details = error as { code?: unknown; data?: unknown; message?: unknown }
        return {
          ok: false as const,
          error: {
            code: details?.code,
            data: details?.data,
            message: typeof details?.message === 'string' ? details.message : String(error),
          },
        }
      }
    }, unsigned.psbtHex)

    const approvalOrRejection = await Promise.race([
      ApprovalsPage.waitForNext(extension.context).then(approval => ({ approval })),
      signedResult.then(result => ({ result })),
    ])
    if ('result' in approvalOrRejection) {
      throw new Error(
        `provider signPsbt settled before approval: ${JSON.stringify(approvalOrRejection.result)}`
      )
    }
    const psbtApproval = approvalOrRejection.approval
    expect(await psbtApproval.contextText()).toContain(origin)
    const psbtSign = await psbtApproval.approvePsbt(1)
    pqcMetrics.record({
      accountId: setup.address,
      durationMs: psbtSign.durationMs,
      inputCount: 1,
      operation: 'dapp-psbt-sign',
    })
    expect(psbtSign.signatureBudget).toContain('Signatures: 1 new')
    const signedOutcome = await signedResult
    if (!signedOutcome.ok) {
      throw new Error(
        `provider signPsbt failed after approval: ${JSON.stringify(signedOutcome.error)}`
      )
    }
    const signedPsbt = signedOutcome.value
    expect(signedPsbt).toMatch(/^[0-9a-f]+$/i)
    expect(signedPsbt).not.toBe(unsigned.psbtHex)

    const broadcastTxid = await dapp.evaluate(psbt => {
      const provider = (window as WindowWithQbit).qbit
      if (!provider) throw new Error('window.qbit is unavailable')
      return provider.pushPsbt(psbt)
    }, signedPsbt)
    regtest.trackTransaction(broadcastTxid)
    await regtest.waitForMempoolTransaction(broadcastTxid)
    expect(await regtest.mempoolFeeBaseUnits(broadcastTxid)).toBeGreaterThan(0)

    await setup.page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings`, {
      waitUntil: 'domcontentloaded',
    })
    const settings = new SettingsPage(setup.page)
    await settings.waitUntilReady()
    await settings.openConnectedSites()
    const connectedSites = new ApprovalsPage(setup.page)
    await connectedSites.waitForConnectedSites()
    expect(await connectedSites.connectedSiteOrigins()).toContain(origin)
    await connectedSites.revokeSite(origin)

    expect(
      await dapp.evaluate(() => {
        const provider = (window as WindowWithQbit).qbit
        if (!provider) throw new Error('window.qbit is unavailable')
        return provider.getAccounts()
      })
    ).toEqual([])
    const revokedError = await dapp.evaluate(async message => {
      try {
        const provider = (window as WindowWithQbit).qbit
        if (!provider) throw new Error('window.qbit is unavailable')
        await provider.signMessage(message)
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, message)
    expect(revokedError).toMatch(/not connected|unauthorized/i)
  } finally {
    await server.close()
  }
})
