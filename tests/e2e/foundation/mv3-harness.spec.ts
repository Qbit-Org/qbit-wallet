import { expect, test } from '../fixtures/test'

test.describe('deterministic MV3 harness', () => {
  test('loads the unpacked extension and a clean regtest service worker', async ({
    extension,
    regtest,
  }) => {
    expect(extension.extensionId).toMatch(/^[a-p]{32}$/)

    const worker = await extension.serviceWorker()
    const manifestVersion = await worker.evaluate(
      () => chrome.runtime.getManifest().manifest_version
    )
    expect(manifestVersion).toBe(3)

    const walletPage = await extension.openWallet('/welcome')
    await expect(walletPage).toHaveURL(
      new RegExp(`^chrome-extension://${extension.extensionId}/index\\.html#/welcome`)
    )

    await expect(walletPage.getByText('Qbit', { exact: true })).toBeVisible()
    await expect(walletPage.getByText('Create new wallet', { exact: true })).toBeVisible()

    const snapshot = await regtest.snapshot()
    expect(snapshot).toMatchObject({
      chain: 'regtest',
      blocks: 0,
      electrsHeight: 0,
      mempoolTxids: [],
    })
  })
})
