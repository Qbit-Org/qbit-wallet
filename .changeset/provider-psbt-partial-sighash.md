---
'@qbit/wallet-background': patch
'@qbit/keyring-service': patch
'@qbit/wallet-shared': patch
---

Sign a provider PSBT input under the sighash type its `PSBT_IN_SIGHASH_TYPE` names, when that type is 0x81 or 0x83. The approval shows each input signed on its own and what the signature locks in (every output for 0x81, one output for 0x83), and no longer counts as the wallet's change or receipts the outputs a 0x83 signature leaves open, nor, under 0x81, any output a 0x83 signature of the same request does not lock in: another approval's input can pay for it. A partial type is signed only for an input that spends the account's own output. A recovery migration still signs only under the default type, every other type is still refused, and an input that names none still signs with the default. An address row flagged `warning` no longer counts as a recipient the wallet named.
