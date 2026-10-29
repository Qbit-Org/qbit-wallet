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

const alice: Contact = {
  name: 'Alice',
  address: OLD_ADDRESS,
  chain: CHAIN,
  isContact: true,
  isAlias: false,
}

const keyOf = (address: string, chain: ChainType) => `${address}_${chain}`

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
    updateContact: vi.fn((contact: Contact) =>
      write(next => next.set(keyOf(contact.address, contact.chain), contact))
    ),
    removeContact: vi.fn((address: string, chain: ChainType) =>
      write(next => next.delete(keyOf(address, chain)))
    ),
    replaceContact: vi.fn((address: string, chain: ChainType, contact: Contact) =>
      write(next => {
        next.delete(keyOf(address, chain))
        next.set(keyOf(contact.address, contact.chain), contact)
      })
    ),
  }

  return {
    wallet,
    contacts: () => [...book.values()],
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

    expect(contacts.wallet.replaceContact).toHaveBeenCalledWith(OLD_ADDRESS, CHAIN, {
      ...alice,
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

    expect(contacts.wallet.updateContact).toHaveBeenCalledWith({ ...alice, name: 'Alice B' })
    expect(contacts.wallet.replaceContact).not.toHaveBeenCalled()
    expect(contacts.contacts()).toEqual([{ ...alice, name: 'Alice B' }])
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
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
