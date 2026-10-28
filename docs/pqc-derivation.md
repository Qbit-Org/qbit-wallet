# Qbit PQC derivation contract

This document records the wallet contract for deriving deterministic Qbit PQC
keys and the fixtures that verify it.

## Scope

`@qbit-oss/pqc` remains the SLH-DSA package. It accepts deterministic keygen
entropy, exposes the Qbit Core leaf-key HKDF helper, signs messages,
and verifies signatures. It does not parse seed phrases, derive BIP32 keys,
build descriptors, or sign transactions.

The wallet layer is responsible for this chain:

```text
mnemonic -> BIP39 seed -> BIP32 root private key
  -> private leaf at m/87h/{coin_type}h/0h/{change}/{index}
  -> qbit Core PQC HKDF using account=0, change=0, index={index}
  -> 128-byte SLH-DSA keygen entropy
  -> @qbit-oss/pqc derivePQCKey/keygen/sign/verify
```

The `master_seed` passed to qbit Core `DerivePQCKey(...)` is the concrete
private BIP32 leaf key bytes, not the BIP39 seed bytes and not the mnemonic.

## Wallet Layer

`@qbit/keyring-service` provides `QbitHdKeyring` for P2MR mnemonic accounts.
The keyring stores the mnemonic/passphrase inside the existing encrypted vault
and derives active account pubkeys and addresses through the canonical path and
HKDF contract above.

For qbit Core recovery/interoperability, `QbitHdKeyring.exportP2mrDescriptors`
exports private receive/change descriptors:

```text
mr(pk(pqc(<network-private-extended-key>/87h/{coin_type}h/0h/0/*)))
mr(pk(pqc(<network-private-extended-key>/87h/{coin_type}h/0h/1/*)))
```

The descriptor path change is `0` or `1`, but the canonical HKDF tuple remains
`account=0, change=0`.

The keyring also persists Qbit Core PQC signature usage counters per
PQC pubkey. `KeyringService.reservePqcSignatureCounter(...)` serializes counter
reservations through a mutex and persists the encrypted vault before returning.
P2MR transaction and message signing consume those reservations so a failed
attempt can be retried without reusing an unsafe counter.

## Descriptor Path

Qbit Core P2MR wallet descriptors use:

```text
mr(pk(pqc(<xprv-or-qprv>/87h/{coin_type}h/0h/{path_change}/*)))
```

The canonical path is:

```text
m/87h/{coin_type}h/0h/{path_change}/{index}
```

Rules:

- Purpose is `87h`.
- Coin type is `0h` on mainnet.
- Coin type is `1h` on testnet4 and regtest.
- Account is `0h` for Qbit Core wallet descriptors.
- Path change is `0` for receive/external addresses and `1` for internal change.
- Index is a non-hardened child number.

Public `xpub` descriptors are not enough to derive PQC public keys, because
the PQC keygen entropy is derived from private leaf key bytes. Qbit Core
therefore rejects public P2MR descriptor imports for watch-only derivation; use
qbit Core `exportpubkeydb` / `importpubkeydb` for watch-only P2MR tracking.

## HKDF

Qbit Core derives the 128-byte SLH-DSA keygen entropy with HKDF-SHA256:

```text
salt = utf8("qbit-sphincs-v1")
info_prefix = utf8("qbit/sphincs+/1")

PRK = HMAC_SHA256(key = salt, data = master_seed)
info = info_prefix || uint32_le(hkdf_account) || uint32_le(hkdf_change) || uint32_le(hkdf_index)
OKM = HKDF-expand-SHA256(PRK, info, 128 bytes)
```

For canonical qbit Core ranged descriptor generation, the HKDF tuple is:

```text
hkdf_account = 0
hkdf_change = 0
hkdf_index = descriptor range position
```

Receive/change separation is encoded in the private BIP32 leaf path:
`.../0/{index}` for receive and `.../1/{index}` for change. Do not also set
`hkdf_change = 1` for canonical wallet generation; that creates a different
PQC key than Qbit Core generates for ranged descriptors at the pinned commit.
The B3 fixture includes a `change=1` vector that exercises Core's matching
rules for known public keys.

`OKM` is passed directly to the bounded30 SLH-DSA seeded keygen. The
`derivePQCKey(masterSeed, account, change, index)` helper returns `{pk32,
sk64}`. The resulting secret key is 64 bytes and the public key is the last 32
bytes of that secret key.

## Fixtures

The fixture is `fixtures/qbit-core-derivation.json` in the `@qbit-oss/pqc`
package (`node_modules/@qbit-oss/pqc/fixtures/qbit-core-derivation.json`),
bound to this repository by the package integrity in
`scripts/security/sdk-package-pins.json`.

It records:

- Qbit Core source files and commit used to define the contract.
- Canonical descriptor generation examples plus explicit recovery/matching and
  primitive-boundary vectors.
- Private leaf seed bytes for deterministic tests.
- Separate BIP32 path fields and HKDF fields to avoid conflating path change
  with canonical descriptor-generation HKDF `change=0`.
- Derived 128-byte keygen entropy.
- Expected public and secret keys from `@qbit-oss/pqc`.
- SHA-256 of the deterministic SLH-DSA signature for each vector.
- Fallback harness provenance for reproducing the Core OKM and key outputs.

`scripts/conformance/pqc-package-vectors.test.mjs` (run by
`pnpm test:pqc-golden`) recomputes the HKDF entropy with Node's `hkdfSync`,
then verifies the fixture with the installed package's WASM and its public
`derivePQCKey(...)` API. The package's own
`test/qbit-core-derivation.test.ts` runs in `Qbit-Org/qbit-pqc`.

## Core Sources

This contract is based on the following Qbit Core code:

- `src/crypto/pqc.cpp`: `DerivePQCKey(...)`, HKDF constants, and SLH-DSA keygen.
- `src/script/descriptor.cpp`: `pqc(...)` descriptor wrapper, canonical
  descriptor-generation HKDF tuple, and recovery matching helpers.
- `src/wallet/scriptpubkeyman.cpp`: descriptor persistence and recovery
  matching.
- `src/libbitcoinpqc/include/libbitcoinpqc/slh_dsa.h` and
  `src/libbitcoinpqc/src/slh_dsa/keygen.c`: bounded30 seeded keygen contract.

Qbit Wallet generates canonical ranged descriptors with HKDF account and
change fixed to `0`.
