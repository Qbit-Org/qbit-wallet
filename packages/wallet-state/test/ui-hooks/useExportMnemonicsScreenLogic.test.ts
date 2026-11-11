import { KeyringType, type WalletKeyring } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { QbitP2mrDescriptorExport } from '../../src/context/WalletContext'
import { useExportMnemonicsScreenLogic } from '../../src/ui-hooks/useExportMnemonicsScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const PASSWORD = 'wallet password'
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type ListedWallet = WalletKeyring & { isCorrupted?: true; corruptedReason?: string }

function healthyWallet(type: string, addressType: AddressType, hdPath: string): ListedWallet {
  return {
    key: 'keyring_0',
    index: 0,
    type,
    addressType,
    accounts: [{ type, pubkey: '02ab', address: 'qb1zexample', key: 'keyring_0#0', flag: 0 }],
    alianName: 'Wallet 1',
    color: 'green',
    hdPath,
  }
}

// As the background lists a wallet whose accounts cannot be read: no accounts
// and an empty hdPath, whatever path its keys are derived on.
function corruptedWallet(type: string, addressType: AddressType): ListedWallet {
  return {
    ...healthyWallet(type, addressType, ''),
    key: 'keyring_2',
    index: 2,
    accounts: [],
    isCorrupted: true,
    corruptedReason: 'No account',
  }
}

// What the background exports for PHRASE on mainnet.
const PHRASE_MAINNET_KEY =
  'qprvYWJDeuDutHd578pyKwiB9KusX7mpASuLrf3ib258bfkqwcJEGy7yqRduhzkWVUujqpWmzyCVbJ6ApM3UjUjt3iy2TXowvuLwoC4LdKSnXGX'
const descriptors: QbitP2mrDescriptorExport = {
  network: 'mainnet',
  coinType: 0,
  containsPrivateKeys: true,
  external: {
    branch: 'external',
    change: 0,
    path: 'm/87h/0h/0h/0/*',
    descriptorNoChecksum: `mr(pk(pqc(${PHRASE_MAINNET_KEY}/87h/0h/0h/0/*)))`,
    descriptor: `mr(pk(pqc(${PHRASE_MAINNET_KEY}/87h/0h/0h/0/*)))#aey82etg`,
  },
  internal: {
    branch: 'internal',
    change: 1,
    path: 'm/87h/0h/0h/1/*',
    descriptorNoChecksum: `mr(pk(pqc(${PHRASE_MAINNET_KEY}/87h/0h/0h/1/*)))`,
    descriptor: `mr(pk(pqc(${PHRASE_MAINNET_KEY}/87h/0h/0h/1/*)))#gc23jx7h`,
  },
  hkdf: { account: 0, change: 0 },
  coreProvenance: {
    repository: 'Qbit-Org/qbit',
    commit: '70fea84f5becfb57463247af09790df5ddd424f8',
    source: 'src/wallet/walletutil.cpp',
  },
}

async function reveal(
  keyring: ListedWallet,
  answer: Record<string, unknown>,
  getMnemonics = vi.fn().mockResolvedValue(answer)
) {
  const wallet = {
    ...createWalletMock(),
    getMnemonics,
    exportP2mrDescriptors: vi.fn().mockResolvedValue(descriptors),
  }
  const harness = createHookTestHarness({ wallet, routeState: { keyring } })
  const { result } = renderHook(() => useExportMnemonicsScreenLogic(), {
    wrapper: harness.wrapper,
  })

  act(() => result.current.setPassword(PASSWORD))
  await act(async () => {
    await result.current.btnClick()
  })

  expect(wallet.getMnemonics).toHaveBeenCalledWith(PASSWORD, keyring)
  return { result, wallet }
}

describe('useExportMnemonicsScreenLogic derivation path', () => {
  it('shows the path of a healthy wallet as before', async () => {
    const keyring = healthyWallet(KeyringType.HdKeyring, AddressType.P2WPKH, "m/84'/0'/0'/0")

    const { result, wallet } = await reveal(keyring, {
      mnemonic: PHRASE,
      hdPath: "m/84'/0'/0'/0",
      passphrase: '',
    })

    expect(result.current.words).toEqual(PHRASE.split(' '))
    expect(result.current.hdPath).toBe("m/84'/0'/0'/0")
    expect(result.current.pathName).toBe('Native Segwit (P2WPKH)')
    expect(result.current.isP2mrKeyring).toBe(false)
    expect(wallet.exportP2mrDescriptors).not.toHaveBeenCalled()
  })

  it.each([
    ["m/84'/0'/0'/0", 'Native Segwit (P2WPKH)'],
    ["m/44'/0'/1'/0", 'custom'],
  ])(
    'shows the path the background returns for a corrupted HD Key Tree wallet (%s)',
    async (hdPath, pathName) => {
      const keyring = corruptedWallet(KeyringType.HdKeyring, AddressType.P2WPKH)

      const { result } = await reveal(keyring, {
        mnemonic: PHRASE,
        hdPath,
        passphrase: 'extra word',
      })

      expect(result.current.mnemonic).toBe(PHRASE)
      expect(result.current.passphrase).toBe('extra word')
      expect(result.current.pathName).toBe(pathName)
      expect(result.current.hdPath).toBe(hdPath)
    }
  )

  it('shows the path and the descriptors of a corrupted Qbit HD wallet', async () => {
    const keyring = corruptedWallet(KeyringType.QbitHdKeyring, AddressType.P2MR)

    const { result, wallet } = await reveal(keyring, {
      mnemonic: PHRASE,
      hdPath: "m/87'/0'/0'/0",
      passphrase: '',
    })

    expect(result.current.hdPath).toBe("m/87'/0'/0'/0")
    expect(result.current.pathName).toBe('Post-Quantum P2MR')
    expect(result.current.isP2mrKeyring).toBe(true)
    expect(wallet.exportP2mrDescriptors).toHaveBeenCalledWith(PASSWORD, keyring)
    expect(result.current.p2mrDescriptors).toEqual(descriptors)
    expect(
      JSON.parse(result.current.importDescriptorsJson).map((entry: { desc: string }) => entry.desc)
    ).toEqual([descriptors.external.descriptor, descriptors.internal.descriptor])
    expect(result.current.error).toBe('')
  })

  // The answer crosses the UI port as JSON, so a missing value arrives as a
  // missing key or null. The listed keyring's empty path is no stand-in for it.
  it.each([
    ['no path', {}],
    ['an empty path', { hdPath: '' }],
    ['a null path', { hdPath: null }],
    ['a path that is not text', { hdPath: 84 }],
  ])('has no path to show when the background returns %s', async (_case, answer) => {
    const keyring = corruptedWallet(KeyringType.HdKeyring, AddressType.P2WPKH)

    const { result } = await reveal(keyring, { mnemonic: PHRASE, passphrase: '', ...answer })

    expect(result.current.mnemonic).toBe(PHRASE)
    expect(result.current.hdPath).toBe('')
  })
})

describe('useExportMnemonicsScreenLogic refusals', () => {
  it('shows a refusal on the password step, as for a wrong password', async () => {
    const keyring = corruptedWallet(KeyringType.HdKeyring, AddressType.P2WPKH)
    // Errors reach the page over the port as plain objects.
    const refused = vi.fn().mockRejectedValue({
      message: 'The selected wallet is no longer available',
      stack: 'at getMnemonics',
    })

    const { result, wallet } = await reveal(keyring, {}, refused)

    expect(result.current.error).toBe('The selected wallet is no longer available')
    expect(result.current.mnemonic).toBe('')
    expect(result.current.hdPath).toBe('')
    expect(wallet.exportP2mrDescriptors).not.toHaveBeenCalled()
  })

  // Never a phrase to split into words: the phrase step would throw while
  // rendering one that is not text.
  it.each([
    ['no phrase', { hdPath: "m/84'/0'/0'/0", passphrase: '' }],
    ['a null phrase', { mnemonic: null, hdPath: "m/84'/0'/0'/0", passphrase: '' }],
    ['an empty phrase', { mnemonic: '', hdPath: "m/84'/0'/0'/0", passphrase: '' }],
    ['a phrase that is not text', { mnemonic: 12, hdPath: "m/84'/0'/0'/0", passphrase: '' }],
  ])('fails, showing an error, when the background returns %s', async (_case, answer) => {
    const keyring = corruptedWallet(KeyringType.QbitHdKeyring, AddressType.P2MR)

    const { result, wallet } = await reveal(keyring, answer)

    expect(result.current.error).toBe('not_supported')
    expect(result.current.mnemonic).toBe('')
    expect(result.current.words).toEqual([''])
    expect(result.current.hdPath).toBe('')
    expect(wallet.exportP2mrDescriptors).not.toHaveBeenCalled()
  })
})

describe('useExportMnemonicsScreenLogic Enter key', () => {
  /** A keydown in the password field, as the field hands it to the screen logic. */
  function keyDown(key: string, { repeat = false, isComposing = false } = {}) {
    return { key, repeat, nativeEvent: { isComposing } } as unknown as KeyboardEvent<HTMLInputElement>
  }

  function renderWithPassword() {
    const keyring = healthyWallet(KeyringType.QbitHdKeyring, AddressType.P2MR, "m/87'/0'/0'/0")
    // As for a wrong password: the background refuses it.
    const getMnemonics = vi.fn().mockRejectedValue({ message: 'Password is incorrect' })
    const exportP2mrDescriptors = vi.fn().mockResolvedValue(descriptors)
    const wallet = { ...createWalletMock(), getMnemonics, exportP2mrDescriptors }
    const harness = createHookTestHarness({ wallet, routeState: { keyring } })
    const { result } = renderHook(() => useExportMnemonicsScreenLogic(), {
      wrapper: harness.wrapper,
    })
    act(() => result.current.setPassword(PASSWORD))
    return { result, keyring, getMnemonics, exportP2mrDescriptors }
  }

  it('submits the password on an Enter pressed in the field', async () => {
    const { result, keyring, getMnemonics, exportP2mrDescriptors } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter'))
    })

    expect(getMnemonics).toHaveBeenCalledTimes(1)
    expect(getMnemonics).toHaveBeenCalledWith(PASSWORD, keyring)
    expect(exportP2mrDescriptors).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Password is incorrect')
    expect(result.current.mnemonic).toBe('')
  })

  it('submits nothing while a held Enter repeats', async () => {
    const { result, getMnemonics } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter', { repeat: true }))
      result.current.handleOnKeyDown(keyDown('Enter', { repeat: true }))
    })

    expect(getMnemonics).not.toHaveBeenCalled()
    expect(result.current.error).toBe('')
  })

  it('submits nothing on the Enter that ends an input method composition', async () => {
    const { result, getMnemonics } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('Enter', { isComposing: true }))
    })

    expect(getMnemonics).not.toHaveBeenCalled()
  })

  it('submits nothing on other keys', async () => {
    const { result, getMnemonics } = renderWithPassword()

    await act(async () => {
      result.current.handleOnKeyDown(keyDown('a'))
      result.current.handleOnKeyDown(keyDown(' '))
    })

    expect(getMnemonics).not.toHaveBeenCalled()
  })
})
