---
'@qbit/wallet-state': minor
---

Check each recovery phrase word while it is entered (#76). `useCreateWalletLogicImportWordsStep` returns `inputWordsInvalid`, one flag per input that is true when the input holds a word that is not in the English word list, and `inputWordsError` is now true only when every word is entered and in the list but the phrase still fails `validateMnemonic`. Switching between 12 and 24 words clears `inputWordsError`. The new `isMnemonicWord(word)` helper next to `validateMnemonic` accepts a word exactly when that check would: it applies the same Unicode normalization and compares case-sensitively against the same list. What Continue accepts and the phrase passed on are unchanged.
