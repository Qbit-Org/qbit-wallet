import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HdKeyring } from '@qbit/keyring-service'
import { QbitHdKeyring } from '@qbit/keyring-service/qbit-hd-keyring'
import { KeyringType } from '@qbit/keyring-service/types'
import type { WalletKeyring } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService } from '../src/services'

vi.mock('../src/services', () => ({
  keyringService: {
    verifyPassword: vi.fn(),
    keyrings: [] as unknown[],
  },
  preferenceService: {
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
  },
  sessionService: {
    broadcastEvent: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

const PASSWORD = 'wallet password'
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NO_LONGER_AVAILABLE = 'The selected wallet is no longer available'

// What keyring-service leaves in the slot of a removed wallet (EmptyKeyring).
function emptySlot() {
  return { type: KeyringType.Empty, serialize: vi.fn(async () => ({})) }
}

// The wallet as a page passes it: listed when the page opened, with the
// public keys of its accounts, then sent over the UI port as JSON. A
// corrupted wallet is listed with no accounts and an empty hdPath.
function fromPage(
  index: number,
  type: string,
  addressType: AddressType,
  pubkeys: string[] = []
): WalletKeyring {
  return JSON.parse(
    JSON.stringify({
      key: 'keyring_' + index,
      index,
      type,
      addressType,
      accounts: pubkeys.map((pubkey, account) => ({
        type,
        pubkey,
        address: 'address of ' + pubkey,
        alianName: 'Account ' + (account + 1),
        index: account,
        key: `keyring_${index}#${account}`,
        flag: 0,
      })),
      alianName: 'Wallet ' + (index + 1),
      color: 'green',
      hdPath: '',
    })
  )
}

function setSlots(...slots: unknown[]) {
  ;(keyringService as unknown as { keyrings: unknown[] }).keyrings = slots
}

// The wallets the background lists now: one for each slot a wallet holds,
// with the accounts its keyring lists. A keyring that lists none is a
// corrupted wallet.
async function listedNow(): Promise<WalletKeyring[]> {
  const slots = (keyringService as unknown as { keyrings: any[] }).keyrings
  const listed: WalletKeyring[] = []
  for (const [index, slot] of slots.entries()) {
    if (slot.type === KeyringType.Empty) continue
    const pubkeys: string[] = slot.getAccounts ? await slot.getAccounts() : []
    listed.push(fromPage(index, slot.type, AddressType.P2WPKH, pubkeys))
  }
  return listed
}

describe('WalletController.getMnemonics', () => {
  let wallet: WalletController

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(true)
    wallet = new WalletController()
    vi.spyOn(wallet, 'getKeyrings').mockImplementation(listedNow)
  })

  it.each([
    [
      'an HD Key Tree wallet',
      () => new HdKeyring({ mnemonic: PHRASE, hdPath: "m/84'/0'/0'/0", activeIndexes: [0] }),
      KeyringType.HdKeyring,
      AddressType.P2WPKH,
      "m/84'/0'/0'/0",
    ],
    [
      'a corrupted HD Key Tree wallet on a custom path',
      () => new HdKeyring({ mnemonic: PHRASE, hdPath: "m/44'/0'/1'/0", activeIndexes: [] }),
      KeyringType.HdKeyring,
      AddressType.P2WPKH,
      "m/44'/0'/1'/0",
    ],
    [
      'a corrupted Qbit HD wallet',
      () => new QbitHdKeyring({ mnemonic: PHRASE, hdPath: "m/87'/0'/0'/0", activeIndexes: [] }),
      KeyringType.QbitHdKeyring,
      AddressType.P2MR,
      "m/87'/0'/0'/0",
    ],
  ])('returns the phrase and path of %s', async (_case, build, type, addressType, hdPath) => {
    const keyring = build()
    setSlots(emptySlot(), keyring)
    const listed = fromPage(1, type, addressType, await keyring.getAccounts())

    await expect(wallet.getMnemonics(PASSWORD, listed)).resolves.toEqual({
      mnemonic: PHRASE,
      hdPath,
      passphrase: '',
    })
    expect(keyringService.verifyPassword).toHaveBeenCalledWith(PASSWORD)
  })

  // An addition whose save fails gives its slot back, and a reset empties
  // every slot, so the next wallet added can take the slot a page listed
  // another wallet in.
  it('refuses a wallet whose slot another wallet of its type took, rather than answer for that one', async () => {
    const listedThen = new HdKeyring({
      mnemonic: PHRASE,
      hdPath: "m/84'/0'/0'/0",
      activeIndexes: [0],
    })
    const holdsNow = {
      type: KeyringType.HdKeyring,
      getAccounts: vi.fn(async () => ['02' + '11'.repeat(32)]),
      serialize: vi.fn(async () => ({ mnemonic: 'another phrase', hdPath: '', passphrase: '' })),
    }
    setSlots(holdsNow)

    const page = fromPage(
      0,
      KeyringType.HdKeyring,
      AddressType.P2WPKH,
      await listedThen.getAccounts()
    )
    await expect(wallet.getMnemonics(PASSWORD, page)).rejects.toThrow(NO_LONGER_AVAILABLE)
    // A corrupted wallet's copy is not taken for a wallet that lists accounts.
    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
    expect(holdsNow.serialize).not.toHaveBeenCalled()
  })

  // Over the UI port a missing public key or address arrives as null.
  it('refuses a first account without a public key or address, rather than match a wallet by it', async () => {
    const keyring = new HdKeyring({ mnemonic: PHRASE, hdPath: "m/84'/0'/0'/0", activeIndexes: [0] })
    setSlots(keyring)
    const read = vi.spyOn(keyring, 'serialize')
    const listed = fromPage(
      0,
      KeyringType.HdKeyring,
      AddressType.P2WPKH,
      await keyring.getAccounts()
    )
    const page = { ...listed, accounts: [{ ...listed.accounts[0]!, pubkey: null, address: null }] }

    await expect(wallet.getMnemonics(PASSWORD, page as unknown as WalletKeyring)).rejects.toThrow(
      NO_LONGER_AVAILABLE
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses when another wallet takes the slot while the wallets are read', async () => {
    const listedThen = new HdKeyring({
      mnemonic: PHRASE,
      hdPath: "m/84'/0'/0'/0",
      activeIndexes: [0],
    })
    const page = fromPage(
      0,
      KeyringType.HdKeyring,
      AddressType.P2WPKH,
      await listedThen.getAccounts()
    )
    setSlots(listedThen)
    vi.mocked(wallet.getKeyrings).mockImplementationOnce(async () => {
      const listed = await listedNow()
      setSlots({ type: KeyringType.HdKeyring, serialize: vi.fn() })
      return listed
    })
    const read = vi.spyOn(listedThen, 'serialize')

    await expect(wallet.getMnemonics(PASSWORD, page)).rejects.toThrow(NO_LONGER_AVAILABLE)
    // The phrase it read is of the wallet the page listed, yet that wallet
    // is no longer in its slot.
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refuses a wallet another window removed, rather than answer for its empty slot', async () => {
    const slot = emptySlot()
    setSlots(new HdKeyring({ mnemonic: PHRASE, activeIndexes: [0] }), slot)

    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(1, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
    expect(slot.serialize).not.toHaveBeenCalled()
  })

  it('refuses a wallet its slot does not hold, rather than answer for the one it does', async () => {
    setSlots(new HdKeyring({ mnemonic: PHRASE, activeIndexes: [0] }))

    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(0, KeyringType.QbitHdKeyring, AddressType.P2MR))
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
  })

  it('refuses a slot past the last wallet', async () => {
    setSlots(new HdKeyring({ mnemonic: PHRASE, activeIndexes: [0] }))

    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(3, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
  })

  // Over the UI port a missing wallet arrives as null, and a slot the port
  // cannot carry (NaN, undefined) as null or no key.
  it.each([
    ['null', null],
    ['an empty object', {}],
    [
      'a slot that is null',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), index: null },
    ],
    [
      'a negative slot',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), index: -1, key: 'keyring_-1' },
    ],
    [
      'a fractional slot',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), index: 0.5 },
    ],
    [
      'a slot given as text',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), index: '0' },
    ],
    [
      'a key of another slot',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), key: 'keyring_1' },
    ],
    [
      'a type that is not text',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), type: 1 },
    ],
    [
      'missing its list of accounts',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), accounts: null },
    ],
    [
      'listed with an account that is not an object',
      { ...fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH), accounts: [null] },
    ],
  ])('refuses a wallet argument that is %s', async (_case, keyring) => {
    const slot = {
      type: KeyringType.HdKeyring,
      serialize: vi.fn(async () => ({ mnemonic: PHRASE })),
    }
    setSlots(slot)

    await expect(
      wallet.getMnemonics(PASSWORD, keyring as unknown as WalletKeyring)
    ).rejects.toThrow('Unknown wallet')
    expect(slot.serialize).not.toHaveBeenCalled()
  })

  it('checks the password before anything about the wallet', async () => {
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(false)
    const slot = emptySlot()
    setSlots(slot)

    await expect(
      wallet.getMnemonics('wrong', fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow('password_error')
    await expect(wallet.getMnemonics('wrong', null as unknown as WalletKeyring)).rejects.toThrow(
      'password_error'
    )
    expect(slot.serialize).not.toHaveBeenCalled()
  })

  it('refuses a wallet without a recovery phrase', async () => {
    const keyPair = {
      type: KeyringType.SimpleKeyring,
      serialize: vi.fn(async () => ['11'.repeat(32)]),
    }
    const fromExtendedKey = {
      type: KeyringType.HdKeyring,
      serialize: vi.fn(async () => ({
        mnemonic: '',
        xpriv: 'extended key',
        hdPath: "m/84'/0'/0'/0",
        passphrase: '',
      })),
    }
    setSlots(keyPair, fromExtendedKey)

    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(0, KeyringType.SimpleKeyring, AddressType.P2WPKH))
    ).rejects.toThrow('not_supported')
    expect(keyPair.serialize).not.toHaveBeenCalled()
    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(1, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow('not_supported')
  })

  it('refuses when the wallet is removed while its keyring is read', async () => {
    const removedDuringRead = {
      type: KeyringType.HdKeyring,
      serialize: vi.fn(async () => {
        setSlots(emptySlot())
        return { mnemonic: PHRASE, hdPath: "m/84'/0'/0'/0", passphrase: '' }
      }),
    }
    setSlots(removedDuringRead)

    await expect(
      wallet.getMnemonics(PASSWORD, fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH))
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
    expect(removedDuringRead.serialize).toHaveBeenCalledTimes(1)
  })
})

describe('WalletController.exportP2mrDescriptors', () => {
  const PUBKEY = '11'.repeat(32)
  let wallet: WalletController

  // A Qbit HD wallet's keyring, as far as the descriptor export reads it.
  function qbitHdSlot(pubkeys: string[] = [PUBKEY]) {
    return {
      type: KeyringType.QbitHdKeyring,
      getAccounts: vi.fn(async () => pubkeys),
      exportP2mrDescriptors: vi.fn(async (network: string) => ({
        network,
        containsPrivateKeys: true,
      })),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(true)
    wallet = new WalletController()
    vi.spyOn(wallet, 'getKeyrings').mockImplementation(listedNow)
  })

  // Over the UI port a wallet argument the page leaves out arrives as null or
  // no argument, and stands for the current wallet; anything else must be a
  // wallet as the page listed it.
  it.each([
    ['an empty object', {}],
    [
      'a slot that is null',
      { ...fromPage(0, KeyringType.QbitHdKeyring, AddressType.P2MR, [PUBKEY]), index: null },
    ],
    [
      'a key of another slot',
      { ...fromPage(0, KeyringType.QbitHdKeyring, AddressType.P2MR, [PUBKEY]), key: 'keyring_1' },
    ],
    [
      'missing its list of accounts',
      { ...fromPage(0, KeyringType.QbitHdKeyring, AddressType.P2MR, [PUBKEY]), accounts: null },
    ],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ])('refuses a wallet argument that is %s', async (_case, keyring) => {
    const slot = qbitHdSlot()
    setSlots(slot)
    const current = vi.spyOn(wallet, 'getCurrentKeyring')

    await expect(
      wallet.exportP2mrDescriptors(PASSWORD, keyring as unknown as WalletKeyring)
    ).rejects.toThrow('Unknown wallet')
    expect(current).not.toHaveBeenCalled()
    expect(slot.exportP2mrDescriptors).not.toHaveBeenCalled()
  })

  it('checks the password before anything about the wallet', async () => {
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(false)
    const slot = qbitHdSlot(['22'.repeat(32)])
    setSlots(slot)

    for (const keyring of [
      // Another wallet's copy, a malformed one and none at all.
      fromPage(0, KeyringType.QbitHdKeyring, AddressType.P2MR, [PUBKEY]),
      {},
      null,
    ]) {
      await expect(
        wallet.exportP2mrDescriptors('wrong', keyring as unknown as WalletKeyring)
      ).rejects.toThrow('password_error')
    }
    expect(wallet.getKeyrings).not.toHaveBeenCalled()
    expect(slot.exportP2mrDescriptors).not.toHaveBeenCalled()
  })

  it('refuses a wallet that is not a Qbit HD wallet on P2MR', async () => {
    const keyring = new HdKeyring({ mnemonic: PHRASE, hdPath: "m/84'/0'/0'/0", activeIndexes: [0] })
    setSlots(keyring)

    await expect(
      wallet.exportP2mrDescriptors(
        PASSWORD,
        fromPage(0, KeyringType.HdKeyring, AddressType.P2WPKH, await keyring.getAccounts())
      )
    ).rejects.toThrow('not_supported')
  })

  it('exports the descriptors of the current wallet when the page names none', async () => {
    const slot = qbitHdSlot()
    setSlots(emptySlot(), slot)
    const [listed] = await listedNow()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      ...listed!,
      addressType: AddressType.P2MR,
    })

    for (const keyring of [undefined, null]) {
      await expect(
        wallet.exportP2mrDescriptors(PASSWORD, keyring as unknown as WalletKeyring)
      ).resolves.toEqual({ network: 'mainnet', containsPrivateKeys: true })
    }
    expect(slot.exportP2mrDescriptors).toHaveBeenCalledTimes(2)

    vi.mocked(wallet.getCurrentKeyring).mockResolvedValue(null)
    await expect(wallet.exportP2mrDescriptors(PASSWORD)).rejects.toThrow('not_supported')
  })
})
