# Access accounts

Account data is available only when the page's exact origin has a persisted grant for the active
Qbit chain. Begin with [`requestAccounts()`](./connect-extension.md#requestaccounts).

## `getAccounts()`

```typescript
getAccounts(): Promise<string[]>;
```

Returns the active Qbit address in a one-element array. It returns an empty array when the origin
has no grant, its grant belongs to another chain, the grant was revoked, or no account is active.
Reading this method never opens an approval.

```javascript
const [address] = await window.qbit.getAccounts()

if (!address) {
  showDisconnectedState()
}
```

## `getPublicKey()`

```typescript
getPublicKey(): Promise<string>;
```

Returns the hex-encoded P2MR public key for the active account. The origin must have a grant for
the active chain.

```javascript
const publicKey = await window.qbit.getPublicKey()
console.log('P2MR public key:', publicKey)
```

Do not infer an address or chain from this value. Use the address returned by `getAccounts()` and
the chain returned by `getChain()`.

## `getBalance()`

```typescript
interface QbitBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
}

getBalance(): Promise<QbitBalance | null>;
```

Returns the active account balance in integer Qbit base units. `total` is the sum represented by
the confirmed and pending balance state. The origin must have a grant for the active chain. The
result is `null` if no account is active.

```javascript
const balance = await window.qbit.getBalance()

if (balance) {
  console.log('Confirmed:', balance.confirmed)
  console.log('Pending:', balance.unconfirmed)
  console.log('Total:', balance.total)
}
```

Treat balances as integers. Do not use floating-point conversions when constructing a
`sendQbit()` amount.

## `accountsChanged`

```typescript
type AccountsChangedHandler = (accounts: string[]) => void

qbit.on('accountsChanged', handler)
qbit.removeListener('accountsChanged', handler)
```

Qbit Wallet emits `accountsChanged` to an origin when the address that origin can read changes,
and only to that origin. Each event carries only what the origin's own grant allows:

- an empty array when access is revoked, or when a wallet-side chain change leaves the origin
  without a grant for the new chain;
- the active address when the origin's grant matches the active chain again, for example after the
  user switches back to the chain the origin was granted on.

An origin whose readable accounts did not change receives no `accountsChanged`. Locking the wallet
emits no `accountsChanged` and keeps every grant. Changing a site setting in Qbit Wallet, such as
quick multi-sign, emits no event.

An empty array does not mean the grant was revoked; a revocation is followed by the
[`disconnect`](./connect-extension.md#disconnect) event. Clear account-derived state, but do not
call `disconnect()` in response, because that revokes the grant the origin still holds.

```javascript
function handleAccountsChanged(accounts) {
  const [address] = accounts
  address ? loadAccountState(address) : clearConnectedAccountState()
}

window.qbit.on('accountsChanged', handleAccountsChanged)
```

On every non-empty update, refetch the public key, balance, chain, and network instead of carrying
state over from the previous account.
