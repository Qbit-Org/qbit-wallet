---
'@qbit/contact-book': patch
---

Keep a contact's place in the list when it is edited. `updateContact` and `replaceContact` now keep the stored contact's `sortIndex` unless `data` sets one, so renaming a contact, or changing its address or network, no longer moves it to the top after the user has reordered the list. `replaceContact` takes the `sortIndex` of the contact it replaces and stores the new entry where the old one was, so it also keeps its place among contacts that share a `sortIndex`, as contacts the user never reordered do. A new contact, including one added for an address that has only an alias, still gets 0. `replaceContact` is still one write, and a failed write still changes nothing.
