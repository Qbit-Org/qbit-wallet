---
'@qbit/preference-service': minor
---

Store wallet colors (#177). `keyringColors` holds a palette key (`WALLET_COLOR_KEYS`) by keyring key. It is empty in a new store and in a store saved before it existed, which otherwise loads as it was saved. `setKeyringColor(key, color)` stores a key, and `getKeyringColor(key)` returns the stored key, or `undefined` when nothing or a value that is not a palette key is stored; it writes nothing. `removeKeyringColor(key)` and `removeKeyringAlianName(key)` forget the color and the name of a wallet that was removed.
