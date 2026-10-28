# Sign and verify P2MR messages

The Qbit V1 provider has one message-signing behavior: `signMessage(text)` creates a structured,
versioned P2MR proof. It does not accept a signature-mode parameter and does not return an opaque
signature string.

## `signMessage(text)`

```typescript
signMessage(text: string): Promise<P2mrMessageProof>;
```

`text` must contain at least one non-whitespace character and its JavaScript `length` may not
exceed 10,000. Qbit Wallet encodes it as UTF-8 and computes two domain-separated hashes:

```text
message_hash = taggedHash("QbitWalletSignedMessage", utf8(text))
datasig_hash = taggedHash("QbitDataSigPQC", message_hash)
```

The active P2MR account signs `datasig_hash`. Before approval, Qbit Wallet shows the exact trusted
origin, account, chain, network, message bytes, and signature-budget impact. The impact is zero
when the exact account and digest have a cached signature and one otherwise. The approval displays
the exact impact for that request.

```javascript
const text = 'Authorize Qbit order 8f4d'
const proof = await window.qbit.signMessage(text)
```

The origin must have a persisted grant for the wallet's active chain. The request is rejected if
the origin, account, chain, network, message, or calculated budget impact changes while approval is
open. Before returning, Qbit Wallet verifies the proof against the exact approved address and
message.

## `P2mrMessageProof`

The merged V1 proof encoding is a structured object. All byte strings are lowercase hexadecimal;
`leaf_version` and `version` are numbers.

```typescript
interface P2mrMessageProof {
  type: 'p2mr-message'
  version: 1
  address: string
  message_hash: string
  datasig_hash: string
  domain: 'QbitDataSigPQC'
  message_domain: 'QbitWalletSignedMessage'
  algorithm: 'SLH-DSA-SHA2-128s-bounded30'
  proof_mode: 'p2mr-pubkey'
  pubkey: string
  signature: string
  leaf_version: number
  leaf_script: string
  control_block: string
  p2mr_merkle_root: string
}
```

`message_hash`, `datasig_hash`, and `p2mr_merkle_root` each encode 32 bytes. `pubkey` encodes the
32-byte P2MR public key and `signature` encodes the 3,680-byte bounded signature. The leaf script,
control block, and root commit the proof to the witness program in `address`.

## `verifyMessage(address, text, proof)`

```typescript
verifyMessage(
  address: string,
  text: string,
  proof: P2mrMessageProof
): Promise<boolean>;
```

Verification is pure: it does not require a connection grant and does not open an approval. It
recomputes both hashes, requires `proof.address` to equal `address`, validates the single-key P2MR
leaf and address commitment, and verifies the bounded signature.

Malformed proofs, changed fields, a different address, or a different message resolve to `false`.

```javascript
const valid = await window.qbit.verifyMessage(address, text, proof)

if (!valid) {
  throw new Error('Invalid P2MR message proof')
}
```

Verification proves only that the P2MR key committed by `address` signed the exact message. The
dapp remains responsible for deciding what that address is authorized to do.
