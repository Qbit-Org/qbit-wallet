# P2MR PSBT Fields

Source of truth: `Qbit-Org/qbit` v1.0.0 (commit `7ebcddb6`), `src/psbt.h`.

## Standard Input Fields

| Type | Name | Key Data | Value |
|---|---|---|---|
| `0x19` | `PSBT_IN_P2MR_SCRIPT_SIG` | `pubkey32 || leaf_hash32` | `signature3680 [hash_type]` |
| `0x1d` | `PSBT_IN_P2MR_LEAF_SCRIPT` | `control_block` | `script || leaf_version` |

The script signature value uses the P2MR witness signature item format described
in [p2mr-sighash.md](./p2mr-sighash.md).

The leaf-script control block must be `1 + 32*n` bytes, no deeper than 128
siblings, and its low bit must be set.

## qbit Proprietary Namespace

Identifier: `qbit`

| Subtype | Name | Key Data | Value |
|---|---|---|---|
| `0x01` | P2MR merkle root | empty | `root32` |
| `0x02` | P2MR leaf script | `control_block` | `script || leaf_version` |
| `0x03` | P2MR script sig | `pubkey32 || leaf_hash32` | `signature3680 [hash_type]` |

The protocol library exposes strict codecs for these fields and keeps the
constants table-driven so a future qbit field migration can be isolated.

## Status

The current protocol slice validates and encodes individual P2MR PSBT fields. A
full bip174 parser/serializer, combiner, signer, finalizer, and extractor remain
for C5.
