import { afterEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_VERSION_NOTICES, getLocalVersionNotice } from '../src/config/local-version-notices'
import { getLocalWalletConfig } from '../src/config/local-wallet-config'
import { getUiControllerMethod } from '../src/controllers/ui-access'
import walletController from '../src/controllers/wallet'

const LOCAL_CONFIG = {
  version: '',
  statusMessage: '',
  chainTip: '',
  disableUtxoTools: true,
}

describe('getLocalWalletConfig', () => {
  it('returns a fresh copy of the release-local configuration', () => {
    const first = getLocalWalletConfig()
    const second = getLocalWalletConfig()

    expect(first).toEqual(LOCAL_CONFIG)
    expect(second).toEqual(LOCAL_CONFIG)
    expect(first).not.toBe(second)

    first.statusMessage = 'caller mutation'
    expect(getLocalWalletConfig()).toEqual(LOCAL_CONFIG)
  })
})

describe('release-local configuration over the UI port', () => {
  // The background resolves a UI request to the controller the same way.
  const callFromUi = (method: string, ...params: unknown[]) =>
    getUiControllerMethod(walletController, method)(...params)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves the wallet configuration without making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(callFromUi('getWalletConfig')).resolves.toEqual(LOCAL_CONFIG)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serves the bundled version notice and leaves updates to the browser store', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(callFromUi('getVersionDetail', '1.2.3')).resolves.toEqual({
      version: '1.2.3',
      title: '',
      changelogs: [],
      notice: '',
    })
    for (const version of Object.keys(LOCAL_VERSION_NOTICES)) {
      await expect(callFromUi('getVersionDetail', version)).resolves.toEqual(
        getLocalVersionNotice(version)
      )
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serves the empty notice for a name every object inherits', async () => {
    await expect(callFromUi('getVersionDetail', 'constructor')).resolves.toEqual({
      version: 'constructor',
      title: '',
      changelogs: [],
      notice: '',
    })
  })
})
