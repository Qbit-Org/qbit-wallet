# P2MR Sighash Layout

Source of truth: `Qbit-Org/qbit` v1.0.0 (commit `7ebcddb6`),
`src/script/interpreter.cpp`.

P2MR signatures use the tagged hash `P2MRSighash`. The implementation delegates
to qbit Core's BIP341-style `SignatureHashSchnorrCommon` with
`SigVersion::P2MR`.

## Witness Signature Item

A P2MR witness signature item is:

- `signature`: 3680 bytes
- optional `hash_type`: 1 byte

If the hash-type byte is absent, the hash type is `SIGHASH_DEFAULT` (`0x00`).
If the byte is present, it must not be `0x00`. The accepted hash types are:

- `0x00`: default, absent from the witness item only
- `0x01`: all
- `0x02`: none
- `0x03`: single
- `0x81`: all plus anyone-can-pay
- `0x82`: none plus anyone-can-pay
- `0x83`: single plus anyone-can-pay

Default behaves as `SIGHASH_ALL` for output commitment while the committed
hash-type byte remains `0x00`.

## Committed Message

The tagged hash message is:

| Order | Field | Included When |
|---|---|---|
| 1 | epoch `0x00` | always |
| 2 | hash type byte | always |
| 3 | transaction version | always |
| 4 | transaction locktime | always |
| 5 | hash of all prevouts | not anyone-can-pay |
| 6 | hash of all spent amounts | not anyone-can-pay |
| 7 | hash of all spent scriptPubKeys | not anyone-can-pay |
| 8 | hash of all input sequences | not anyone-can-pay |
| 9 | hash of all outputs | output type is all/default |
| 10 | spend type `(ext_flag << 1) + annex_present` | always; P2MR `ext_flag = 1` |
| 11 | current input outpoint | anyone-can-pay |
| 12 | current spent output | anyone-can-pay |
| 13 | current input sequence | anyone-can-pay |
| 14 | input index | not anyone-can-pay |
| 15 | annex hash | annex present |
| 16 | hash of matching single output | output type is single |
| 17 | P2MR leaf hash | always |
| 18 | key version `0x00` | always |
| 19 | code separator position | always |

P2MR uses the same message shape as Tapscript here, but under the distinct
`P2MRSighash` tag and with P2MR leaf hashes/scripts.

## Status

This document and the accompanying protocol codecs lock down the field and
signature-item contracts. Full `p2mrSighash(tx, ...)` implementation still needs
byte-exact qbit Core fixtures and regtest acceptance before it should be used by
wallet signing.
