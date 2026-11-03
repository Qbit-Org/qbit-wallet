import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { useEditContactScreenLogic } from '../../src/ui-hooks/useEditContactScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const OLD_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
const NEW_ADDRESS = 'qb1zz4ef9ln2kkrnvhxnkclzjgh0q58vxw56gh57l43n7lfnte94cd0qfv03et'
const CHAIN = ChainType.QBIT_MAINNET

interface Contact {
  name: string
  address: string
  chain: ChainType
  isContact: boolean
  isAlias: boolean
  sortIndex?: number
}

type ContactInput = Omit<Contact, 'isAlias'> & { isAlias?: boolean }

const alice: Contact = {
  name: 'Alice',
  address: OLD_ADDRESS,
  chain: CHAIN,
  isContact: true,
  isAlias: false,
}

const bob: Contact = {
  name: 'Bob',
  address: NEW_ADDRESS,
  chain: CHAIN,
  isContact: true,
  isAlias: false,
}

const keyOf = (address: string, chain: ChainType) => `${address}_${chain}`

// As the contact book stores it: an unset alias flag keeps the existing entry's
const toStored = (contact: ContactInput, existing?: Contact): Contact => ({
  ...contact,
  isAlias: contact.isAlias ?? existing?.isAlias ?? false,
})

// Contact methods that behave like the contact book's: each call is one
// storage write, and the contacts change only once that write succeeds.
function createContactsWallet(contacts: Contact[]) {
  let book = new Map(contacts.map(contact => [keyOf(contact.address, contact.chain), contact]))
  let refuses: (next: Map<string, Contact>) => boolean = () => false
  let writes = 0

  const write = async (change: (next: Map<string, Contact>) => void) => {
    const next = new Map(book)
    change(next)
    writes++
    if (refuses(next)) throw new Error('QUOTA_BYTES quota exceeded')
    book = next
  }

  const wallet = {
    ...createWalletMock(),
    getContactByAddressAndChain: vi.fn(async (address: string, chain: ChainType) =>
      book.get(keyOf(address, chain))
    ),
    updateContact: vi.fn((contact: ContactInput) =>
      write(next => {
        const key = keyOf(contact.address, contact.chain)
        next.set(key, toStored(contact, next.get(key)))
      })
    ),
    removeContact: vi.fn((address: string, chain: ChainType) =>
      write(next => next.delete(keyOf(address, chain)))
    ),
    replaceContact: vi.fn((address: string, chain: ChainType, contact: ContactInput) =>
      write(next => {
        const key = keyOf(address, chain)
        const newKey = keyOf(contact.address, contact.chain)
        const existing = next.get(newKey)
        if (newKey !== key && existing?.isContact) {
          throw Object.assign(new Error('Another contact has this address and network'), {
            code: 'CONTACT_ALREADY_EXISTS',
          })
        }
        next.delete(key)
        next.set(newKey, toStored(contact, existing))
      })
    ),
  }

  return {
    wallet,
    contacts: () => [...book.values()],
    // Store a contact as another page would, outside this screen.
    put: (contact: Contact) => {
      book = new Map(book).set(keyOf(contact.address, contact.chain), contact)
    },
    writes: () => writes,
    // Make storage refuse every write that would hold this key.
    refuseWritesHolding: (key: string) => {
      refuses = next => next.has(key)
    },
    refuseAllWrites: () => {
      refuses = () => true
    },
  }
}

async function renderEditScreen(contacts = createContactsWallet([alice])) {
  const harness = createHookTestHarness({
    wallet: contacts.wallet as any,
    routeState: { address: OLD_ADDRESS, chain: CHAIN },
  })
  const view = renderHook(() => useEditContactScreenLogic(), { wrapper: harness.wrapper })
  await waitFor(() => expect(view.result.current.name).toBe('Alice'))
  return { ...harness, ...view, contacts }
}

describe('useEditContactScreenLogic', () => {
  it('moves a contact to a new address with one write', async () => {
    const { result, contacts, navigation } = await renderEditScreen()

    act(() => result.current.handleAddressChange(NEW_ADDRESS))
    await act(() => result.current.handleSubmit())

    const { isAlias: _unset, ...edit } = alice
    expect(contacts.wallet.replaceContact).toHaveBeenCalledWith(OLD_ADDRESS, CHAIN, {
      ...edit,
      address: NEW_ADDRESS,
    })
    expect(contacts.wallet.removeContact).not.toHaveBeenCalled()
    expect(contacts.wallet.updateContact).not.toHaveBeenCalled()
    expect(contacts.writes()).toBe(1)
    expect(contacts.contacts()).toEqual([{ ...alice, address: NEW_ADDRESS }])
    expect(result.current.error).toBe('')
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
  })

  it('keeps the contact under its old address when the write of the new one fails', async () => {
    const { result, contacts, navigation } = await renderEditScreen()
    contacts.refuseWritesHolding(keyOf(NEW_ADDRESS, CHAIN))

    act(() => result.current.handleAddressChange(NEW_ADDRESS))
    await act(() => result.current.handleSubmit())

    expect(contacts.contacts()).toEqual([alice])
    expect(result.current.error).toBe('failed_to_save_contact')
    expect(result.current.loading).toBe(false)
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it('saves a name change in place with updateContact', async () => {
    const { result, contacts, navigation } = await renderEditScreen()

    act(() => result.current.handleNameChange('Alice B'))
    await act(() => result.current.handleSubmit())

    const { isAlias: _unset, ...edit } = alice
    expect(contacts.wallet.updateContact).toHaveBeenCalledWith({ ...edit, name: 'Alice B' })
    expect(contacts.wallet.replaceContact).not.toHaveBeenCalled()
    expect(contacts.contacts()).toEqual([{ ...alice, name: 'Alice B' }])
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
  })

  it('keeps the alias flag of a contact that is also an alias', async () => {
    const { result, contacts, navigation } = await renderEditScreen(
      createContactsWallet([{ ...alice, isAlias: true }])
    )

    act(() => result.current.handleNameChange('Alice B'))
    await act(() => result.current.handleSubmit())

    expect(contacts.wallet.updateContact.mock.calls[0]?.[0]).not.toHaveProperty('isAlias')
    expect(contacts.contacts()).toEqual([{ ...alice, name: 'Alice B', isAlias: true }])
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
  })

  it('refuses to move a contact onto another contact and leaves both as they were', async () => {
    const { result, contacts, navigation } = await renderEditScreen(
      createContactsWallet([alice, bob])
    )

    act(() => result.current.handleAddressChange(NEW_ADDRESS))
    await act(() => result.current.handleSubmit())

    expect(contacts.wallet.replaceContact).not.toHaveBeenCalled()
    expect(contacts.writes()).toBe(0)
    expect(contacts.contacts()).toEqual([alice, bob])
    expect(result.current.error).toBe('another_contact_has_this_address')
    expect(result.current.loading).toBe(false)
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it('shows the same error when the contact book refuses a move onto a contact stored since', async () => {
    const { result, contacts, navigation } = await renderEditScreen()
    // Bob is stored elsewhere just after this screen checked the address.
    contacts.wallet.getContactByAddressAndChain.mockImplementationOnce(async () => {
      contacts.put(bob)
      return undefined
    })

    act(() => result.current.handleAddressChange(NEW_ADDRESS))
    await act(() => result.current.handleSubmit())

    expect(contacts.wallet.replaceContact).toHaveBeenCalledTimes(1)
    expect(contacts.contacts()).toEqual([alice, bob])
    expect(result.current.error).toBe('another_contact_has_this_address')
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it('shows an error and keeps the contact when deleting it fails', async () => {
    const { result, contacts, navigation } = await renderEditScreen()
    contacts.refuseAllWrites()

    await act(() => result.current.handleDelete())

    expect(contacts.wallet.removeContact).toHaveBeenCalledWith(OLD_ADDRESS, CHAIN)
    expect(contacts.contacts()).toEqual([alice])
    expect(result.current.error).toBe('failed_to_delete_contact')
    expect(result.current.loading).toBe(false)
    expect(navigation.navigate).not.toHaveBeenCalled()
  })
})
