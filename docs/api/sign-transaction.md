# Sign, send, and broadcast Qbit transactions

The V1 provider accepts only Qbit PSBTs and raw Qbit transactions. Signing is restricted to keys
owned by the active P2MR account.

## Chain-bound signing options

```typescript
type QbitChain = 'QBIT_MAINNET' | 'QBIT_TESTNET4' | 'QBIT_REGTEST'

interface QbitSignPsbtOptions {
  chain: QbitChain
  autoFinalized?: boolean
}
```

`chain` is required. A Qbit PSBT does not encode a network discriminator, so Qbit Wallet cannot
safely infer its chain from the bytes. The requested chain must equal the wallet's active chain
and the chain in the origin's persisted grant.

`chain` and `autoFinalized` are the only accepted keys. The wallet signs every input the active
account can sign, and a dapp cannot select a subset: an options object with any other key, such
as `toSignInputs`, is rejected. So is an `autoFinalized` that is not a boolean.

`autoFinalized` decides whether the returned PSBT is finalized:

- Omitted: Qbit Wallet finalizes the PSBT when its own signatures complete every input. When an
  input still needs another signer, or carries P2MR entries the wallet cannot finalize, it returns
  the PSBT with its signatures added and no input finalized, for the other signers to complete.
- `true`: the result must be finalized. A PSBT the wallet cannot finalize after signing is
  rejected before approval, so no signature is spent.
- `false`: the result is never finalized.

Malformed options and a `signPsbts()` call without one options entry for each of 1-20 PSBTs are
rejected with `-32602` before approval. Unknown and mismatched chains are rejected with `4901`.
Malformed PSBTs, and signing plans that do not belong to the active account, are also rejected
before approval.

The witness reveals the active account's P2MR leaf with one control block, so an input the account
signs must list that leaf in exactly one leaf record, whose control block commits to the input's
witness UTXO. A PSBT that lists the account's leaf more than once on an input, even when every
record commits, or with a control block that does not commit, is rejected with `-32602` before
approval, so no signature is spent. So is such an input whose witness UTXO is not a P2MR output, or
whose P2MR merkle root differs from that output's program. Leaf records for other leaves are not
checked.

## `signPsbt(psbtHex, options)`

```typescript
signPsbt(
  psbtHex: string,
  options: QbitSignPsbtOptions
): Promise<string>;
```

Returns the signed Qbit PSBT as lowercase hex, finalized as `autoFinalized` decides. An
unfinalized result retains the newly added signatures for the other signers.

```javascript
const chain = await window.qbit.getChain()

// Finalized when the wallet's signatures complete every input.
const signedPsbtHex = await window.qbit.signPsbt(unsignedPsbtHex, { chain })

// Always partially signed, for a PSBT with other signers.
const partialPsbtHex = await window.qbit.signPsbt(sharedPsbtHex, {
  chain,
  autoFinalized: false,
})
```

## `signPsbts(psbtHexs, options)`

```typescript
signPsbts(
  psbtHexs: string[],
  options: QbitSignPsbtOptions[]
): Promise<string[]>;
```

The arrays must contain 1-20 entries and have the same length. Each options entry independently
declares the chain for the PSBT at the same index. The returned signed PSBTs preserve input order.

```javascript
const chain = await window.qbit.getChain()

const signed = await window.qbit.signPsbts(
  [firstPsbtHex, secondPsbtHex],
  [{ chain }, { chain, autoFinalized: false }]
)
```

The batch approval identifies and binds every ordered item separately. A change to any item
invalidates the whole request.

## Transaction approval contents

Before signing a single PSBT, a batch, or a `sendQbit()` transaction, Qbit Wallet shows the values
that determine what will be signed:

- Exact trusted origin, active account, chain, and network.
- Every input prevout, input value, and P2MR key used for that input.
- Every output value and raw output script.
- The exact fee.
- The raw memo output script, encoded memo bytes, and decoded chunks when present.
- Per-input and aggregate signature-budget impact, including cache reuse.

Qbit Wallet binds this display to an immutable request snapshot. It rechecks the context, unsigned
inputs and outputs, signing plan, and budget immediately before and after signing. A changed
approval payload or returned PSBT is rejected.

## `pushPsbt(psbtHex)`

```typescript
pushPsbt(psbtHex: string): Promise<string>;
```

Broadcasts a fully signed Qbit PSBT through the active chain endpoint and returns its transaction
identifier. The origin needs a grant for the active chain.

```javascript
const txid = await window.qbit.pushPsbt(signedPsbtHex)
```

## `pushTx(rawHex)`

```typescript
pushTx(rawHex: string): Promise<string>;
```

Broadcasts a fully signed raw Qbit transaction through the active chain endpoint and returns its
transaction identifier. Raw transaction hex and PSBT hex are different encodings and are not
interchangeable.

```javascript
const txid = await window.qbit.pushTx(rawTransactionHex)
```

### Broadcast results

`pushPsbt()` and `pushTx()` resolve with the identifier Qbit Wallet computes from the transaction,
once the endpoint answers with that identifier. They report a failed broadcast the same way
`sendQbit()` does:

- When the broadcast fails after the transaction has left the wallet, for example because the
  endpoint times out, answers with a gateway error, or answers without the transaction identifier,
  Qbit Wallet looks the transaction up. If the lookup finds it, the call resolves with its
  identifier as usual. Otherwise the call rejects with code `-32010`, the
  [unknown broadcast outcome](#unknown-broadcast-outcome) error, and `data.txid` names the
  transaction the pushed bytes encode. Do not build another transaction over its inputs before you
  have looked `data.txid` up on the chain.
- Any other error means the transaction was not broadcast: it was refused before the bytes left the
  wallet, or the node definitively rejected it and repeated lookups, a few seconds apart, found it
  absent. The message carries the node's reason when there is one, without the endpoint's address
  or response body.

After an unknown outcome, Qbit Wallet keeps the transaction's inputs reserved, as it does for
`sendQbit()`, only when the user approved signing that exact transaction with `signPsbt()` or
`signPsbts()`, for any site, since the extension's background last started; the wallet remembers
the last 256 such transactions. A push needs no approval, so the inputs of any other pushed
transaction stay available to new transactions.

### Recently spent inputs

`signPsbt()`, `signPsbts()`, `pushPsbt()` and `pushTx()` reject a transaction that spends an
input a recent broadcast from the wallet already spent, unless it is that same transaction.
This guards a pending payment against a conflicting transaction built from an outdated list of
unspent outputs, whether the wallet broadcasts it or not. As a consequence, a replacement (RBF)
of a pending transaction cannot be signed or broadcast through the wallet while the original is
still recorded as pending. The record ends when the wallet sees
the original confirmed, or finds it gone at least 10 minutes after it last saw it pending.

## `sendQbit(toAddress, satoshis, options)`

```typescript
interface SendQbitOptions {
  feeRate?: number;
  memo?: string;
  memos?: string[];
}

sendQbit(
  toAddress: string,
  satoshis: number,
  options?: SendQbitOptions
): Promise<string>;
```

Builds, approves, signs, and broadcasts a P2MR transaction on the active chain. `toAddress` must
be a P2MR address for that chain, and `satoshis` is an integer number of Qbit base units. If
`feeRate` is omitted, Qbit Wallet selects its normal current fee rate.

```javascript
const txid = await window.qbit.sendQbit(recipientAddress, 25_000, {
  feeRate: 2,
  memo: '716269742d6f726465722d38663464',
})
```

Memo strings containing only an even number of hexadecimal characters are decoded as bytes. Other
memo strings are UTF-8 encoded. A non-empty `memo` creates one data chunk and takes precedence when
both `memo` and `memos` are present; `memos` creates one ordered chunk per array entry. Review the
exact bytes and raw output script in the approval rather than relying on the displayed text alone.

`sendQbit()` returns the broadcast transaction identifier. It rejects if the recipient, amount,
fee, memo bytes, inputs, outputs, account, origin, chain, network, or signature budget differs from
the approved snapshot.

### Unknown broadcast outcome

A broadcast can fail after the signed transaction has left the wallet, for example when the
endpoint times out or answers with a gateway error. In that case, the node may already hold the
transaction. Qbit Wallet first looks the transaction up. If the lookup finds it, `sendQbit()`
resolves with its identifier as usual. Otherwise `sendQbit()` rejects with this error:

```typescript
interface QbitBroadcastOutcomeUnknownError {
  code: -32010
  message: string
  data: {
    outcome: 'unknown'
    chain: QbitChain
    txid: string // the approved or pushed transaction, which may be in the mempool
  }
}
```

Qbit Wallet keeps the transaction's inputs reserved, so a later send cannot spend them again,
until the wallet sees the transaction confirmed or finds it gone from the network. The
reservation lives in the extension's background memory and expires 24 hours after the wallet
last saw the transaction pending. A browser restart, or the extension's background being stopped
and restarted, clears it, so do not rely on it in place of looking the transaction up.
Do not retry `sendQbit()` blindly after this error: a new request builds a new transaction and can
pay the recipient twice. Look up `data.txid` on the chain first, and treat the payment as made if
the transaction is found.

`sendQbit()` rejects with any other error only when the transaction was not broadcast. Such a
failure happens before the bytes leave the wallet, or the node definitively rejects the transaction
and repeated lookups find it absent. Its inputs are released.
