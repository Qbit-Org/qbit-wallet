import { CHAINS_MAP } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { useEffect, useState } from 'react'
import { useI18n, useNavigation, useWallet } from 'src/context'
import { isValidAddress } from 'src/utils/qbit-utils'

// The code @qbit/contact-book's addContact and replaceContact reject with when
// another contact has the address and network
const CONTACT_ALREADY_EXISTS = 'CONTACT_ALREADY_EXISTS'

export function useEditContactScreenLogic() {
  const nav = useNavigation()

  // Required parameters
  const { address, chain, selectedNetworkFilter } = nav.getRouteState<'EditContactScreen'>()
  const wallet = useWallet()
  const [name, setName] = useState('')
  const [contactAddress, setContactAddress] = useState(address || '')
  const [originalAddress, setOriginalAddress] = useState('')
  const [originalChain, setOriginalChain] = useState<ChainType | undefined>()
  const [chainType, setChainType] = useState<ChainType>(ChainType.QBIT_TESTNET4)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    if (address) {
      fetchContact()
    } else {
      const preselectedChainType = selectedNetworkFilter as ChainType

      if (preselectedChainType) {
        setChainType(preselectedChainType)
      }
    }
  }, [address, chain, selectedNetworkFilter])

  const fetchContact = async () => {
    if (!address || !chain) return

    try {
      const chainEnum = chain as ChainType
      const contact = await wallet.getContactByAddressAndChain(address, chainEnum)

      if (contact) {
        setName(contact.name)
        setContactAddress(contact.address)
        setOriginalAddress(contact.address)
        setOriginalChain(contact.chain)
        setChainType(contact.chain)
      } else {
        setError(t('contact_not_found'))
        setTimeout(() => {
          nav.navigate('ContactsScreen', {})
        }, 1500)
      }
    } catch (err) {
      console.error('Error fetching contact:', err)
      setError(t('failed_to_load_contact_information'))
    }
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError(t('please_enter_name'))
      return
    }

    if (!contactAddress.trim()) {
      setError(t('please_enter_address'))
      return
    }

    const networkType = CHAINS_MAP[chainType].networkType

    if (!isValidAddress(contactAddress, networkType)) {
      setError(t('invalid_address_format_for_selected_network'))
      return
    }

    setError('')
    setLoading(true)

    try {
      // No isAlias, so the contact book keeps the stored alias flag
      const contact = {
        name: name.trim(),
        address: contactAddress.trim(),
        chain: chainType,
        isContact: true,
      }

      // False in add mode, where no contact was loaded
      const keepsKey = originalAddress === contact.address && originalChain === contact.chain

      if (!keepsKey) {
        const other = await wallet.getContactByAddressAndChain(contact.address, contact.chain)
        if (other?.isContact) {
          setError(t('another_contact_has_this_address'))
          return
        }
      }

      // The contact book refuses an add or a move too if another contact took
      // the address since the check above.
      if (!originalAddress || !originalChain) {
        await wallet.addContact(contact)
      } else if (!keepsKey) {
        // One write, so a failure keeps the contact under its old address
        await wallet.replaceContact(originalAddress, originalChain, contact)
      } else {
        await wallet.updateContact(contact)
      }

      nav.goBack()
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === CONTACT_ALREADY_EXISTS) {
        setError(t('another_contact_has_this_address'))
      } else {
        setError(t('failed_to_save_contact'))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!address || !originalChain) return

    setLoading(true)
    try {
      await wallet.removeContact(address, originalChain)

      nav.navigate('ContactsScreen', {
        returnWithNetwork: chainType,
      })
    } catch (err) {
      setError(t('failed_to_delete_contact'))
    } finally {
      setLoading(false)
    }
  }

  const handleAddressChange = (e: { target: { value: string } } | string) => {
    const value = (typeof e === 'string' ? e : e.target.value).trim()
    setContactAddress(value)

    if (
      error.includes('Invalid address') ||
      error === t('another_contact_has_this_address') ||
      !value
    ) {
      setError('')
    }

    if (value) {
      const networkType = CHAINS_MAP[chainType].networkType

      if (value.length > 15 && !isValidAddress(value, networkType)) {
        setError(t('invalid_address_format_for_selected_network'))
      }
    }
  }

  const handleNameChange = (e: { target: { value: string } } | string) => {
    const value = typeof e === 'string' ? e : e.target.value
    setName(value)
  }

  const onClickBack = () => {
    nav.goBack()
  }

  return {
    name,
    contactAddress,
    chainType,
    error,
    loading,
    handleNameChange,
    handleAddressChange,
    handleSubmit,
    handleDelete,
    onClickBack,
    address,
    t,
  }
}
