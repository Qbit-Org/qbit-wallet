import { describe, expect, it } from 'vitest'

import { ChainType } from '@qbit/wallet-types'
import { ContactBookService } from '../src/contact-book'
import {
  RELEASES,
  readReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// chrome.storage.local hands out copies, and keeps copies of what it is given.
class DumpStorage {
  constructor(readonly values: Record<string, unknown>) {}

  async get(key: string): Promise<any> {
    return structuredClone(this.values[key])
  }

  async set(key: string, value: any): Promise<void> {
    this.values[key] = structuredClone(value)
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

describe.each(RELEASES)('contacts stored by %s', release => {
  it('load with the contact the release saved', async () => {
    const dump = readReleaseStorage(release)
    const contactBook = new ContactBookService()
    await contactBook.init({ storage: new DumpStorage(dump.storage) as any, logger })

    expect(dump.wallet.contacts).toHaveLength(1)
    const [contact] = dump.wallet.contacts
    expect(contactBook.listContacts()).toEqual(dump.wallet.contacts)
    expect(
      contactBook.getContactByAddressAndChain(contact!.address, contact!.chain as ChainType)
    ).toMatchObject({ name: contact!.name, isContact: true, isAlias: false })
  })

  it('keep that contact when the next change is saved', async () => {
    const dump = readReleaseStorage(release)
    const storage = new DumpStorage(dump.storage)
    const contactBook = new ContactBookService()
    await contactBook.init({ storage: storage as any, logger })
    const added = {
      name: 'Added after the update',
      address: dump.wallet.keyrings[0]!.accounts[0]!.address,
      chain: ChainType.QBIT_TESTNET4,
      isAlias: false,
      isContact: true,
    }

    await contactBook.updateContact(added)

    const reloaded = new ContactBookService()
    await reloaded.init({ storage: storage as any, logger })
    expect(reloaded.listContacts().map(item => item.name)).toEqual(
      expect.arrayContaining([dump.wallet.contacts[0]!.name, added.name])
    )
  })
})
