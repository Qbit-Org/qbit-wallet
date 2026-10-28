import { ChainType } from '@qbit/wallet-types'
import { ContactBookService } from '@qbit/contact-book'

// Export the contact-book service interfaces used by the extension UI.
export interface ContactBookItem {
  name: string
  address: string
  chain: ChainType
  isAlias: boolean
  isContact: boolean
  sortIndex?: number
}

export interface UIContactBookItem {
  name: string
  address: string
}

const contactBookService = new ContactBookService()

export default contactBookService
