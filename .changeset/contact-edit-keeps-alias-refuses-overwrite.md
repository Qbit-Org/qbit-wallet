---
'@qbit/contact-book': patch
'@qbit/wallet-state': patch
---

Editing a contact no longer clears its alias flag or silently replaces another contact. `updateContact`, `addContact` and `replaceContact` now take `isAlias` as optional: left unset, the stored entry keeps the alias flag of the entry already under the contact's address and chain, and a contact moved to an address with no entry gets `false`. A caller that sets `isAlias` still decides it. `replaceContact` now rejects with `ContactAlreadyExistsError` (`code` `CONTACT_ALREADY_EXISTS`) and changes nothing when another contact is stored under the new address and chain. It checks the store at the time of the write, so a screen that loaded before that contact was added cannot overwrite it. Address matching is exact, as in the stored key. An edit that keeps the contact's own address and chain, or that moves it onto an alias-only entry, still saves. The edit screen (`useEditContactScreenLogic`) no longer sends `isAlias`. It checks the new address before saving, and in either case it shows "Another contact already has this address on this network" instead of saving.
