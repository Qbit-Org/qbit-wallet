# Qbit hardware signing

Qbit Wallet currently signs P2MR outputs with software Qbit HD keyrings.
P2MR spends require SLH-DSA post-quantum signatures, and the extension does not
have a hardware signer that can produce them.

## Wallet behavior

- The add-wallet flow explains the software-keyring requirement.
- The wallet offers no cold-wallet creation or extended-public-key account
  derivation. A vault that already holds a `ColdWalletKeyring` still loads.
- `KeyringService.addKeyring` rejects new `ColdWalletKeyring` instances as a
  second enforcement layer.
- `canCreateQbitSendRequest` requires a P2MR account with a supported signing
  path.

Hardware integration is tracked in [Qbit-Org/qbit-wallet#53](https://github.com/Qbit-Org/qbit-wallet/issues/53).
It requires a signer that supports Qbit SLH-DSA operations and a reviewed
external-signer boundary.
