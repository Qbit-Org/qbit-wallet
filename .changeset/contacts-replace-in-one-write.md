---
'@qbit/contact-book': patch
'@qbit/wallet-background': patch
'@qbit/wallet-state': patch
---

Stop losing a contact when changing its address or network fails to save. The new `ContactBookService.replaceContact(address, chain, data)` removes the contact under the old address and network and stores `data` in one write. The result is the one `removeContact` followed by `updateContact` gave: an old entry that is also an alias stays as an alias, the new entry gets the given `sortIndex` or 0, and an entry already stored under the new address is replaced. A failed write rejects and leaves the original contact in place, in memory and on disk. The stored contact book keeps its key and shape. The wallet controller's new `replaceContact` is open to the wallet's own pages, and `useEditContactScreenLogic` uses it when the address or network changes, so a failed save keeps the contact under its old address.
