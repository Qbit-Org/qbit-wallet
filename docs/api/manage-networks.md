# Manage Qbit chains and networks

The V1 chain and network values are exact, case-sensitive strings:

```typescript
type QbitChain = 'QBIT_MAINNET' | 'QBIT_TESTNET4' | 'QBIT_REGTEST'
type QbitNetwork = 'mainnet' | 'testnet4' | 'regtest'
```

| Chain           | Network    |
| --------------- | ---------- |
| `QBIT_MAINNET`  | `mainnet`  |
| `QBIT_TESTNET4` | `testnet4` |
| `QBIT_REGTEST`  | `regtest`  |

Any other value is unsupported. Qbit Wallet rejects unsupported values before opening a signing
approval or using signing keys.

## `getChain()`

```typescript
getChain(): Promise<QbitChain>;
```

Returns the active chain enum. This method does not require an account grant.

```javascript
const chain = await window.qbit.getChain()
// "QBIT_MAINNET", "QBIT_TESTNET4", or "QBIT_REGTEST"
```

## `switchChain(chain)`

```typescript
switchChain(chain: QbitChain): Promise<void>;
```

Requests a switch to the exact Qbit chain. A different supported chain requires user approval.
After a successful provider-driven switch, the requesting origin's grant is scoped to the new
chain.

```javascript
await window.qbit.switchChain('QBIT_TESTNET4')
console.log(await window.qbit.getChain()) // "QBIT_TESTNET4"
```

### Connect, then switch

`switchChain()` requires the origin's grant on the wallet's active chain. Without one, it rejects
with `4100` and shows no switch approval. A dapp set up for a chain other than the wallet's active
one must connect first, with [`requestAccounts()`](./connect-extension.md#requestaccounts), and
then switch:

```javascript
async function connectOn(chain) {
  await window.qbit.requestAccounts()
  if ((await window.qbit.getChain()) !== chain) {
    try {
      await window.qbit.switchChain(chain)
    } catch (error) {
      // The active chain changed after connecting: connect on it, then switch.
      if (error.code !== 4100) throw error
      await window.qbit.requestAccounts()
      await window.qbit.switchChain(chain)
    }
  }
  return window.qbit.getAccounts()
}
```

The user approves the connection and the switch separately. If the wallet is locked, Qbit Wallet
asks the user to unlock it first, then shows the switch approval for the unlocked account.

## `getNetwork()`

```typescript
getNetwork(): Promise<QbitNetwork>;
```

Returns the canonical network name for the active chain. This method does not require an account
grant.

```javascript
const network = await window.qbit.getNetwork()
// "mainnet", "testnet4", or "regtest"
```

## `switchNetwork(network)`

```typescript
switchNetwork(network: QbitNetwork): Promise<void>;
```

Requests a switch by canonical network name. The chain and network mapping is one-to-one in V1,
so this has the same permission and approval behavior as `switchChain()`.

```javascript
await window.qbit.switchNetwork('regtest')
console.log(await window.qbit.getNetwork()) // "regtest"
```

## Change events

```typescript
type ChainChangedHandler = (chain: QbitChain) => void
type NetworkChangedHandler = (network: QbitNetwork) => void

qbit.on('chainChanged', chainHandler)
qbit.on('networkChanged', networkHandler)

qbit.removeListener('chainChanged', chainHandler)
qbit.removeListener('networkChanged', networkHandler)
```

Qbit Wallet emits both events to every connected origin after the active chain changes, whether
the change originated from the provider or wallet controls. Read both values again before
preparing another request.

```javascript
async function reloadChainState() {
  const [chain, network, accounts] = await Promise.all([
    window.qbit.getChain(),
    window.qbit.getNetwork(),
    window.qbit.getAccounts(),
  ])

  renderChainState({ chain, network, accounts })
}

window.qbit.on('chainChanged', reloadChainState)
```

A wallet-side chain change does not transfer the origin's old grant. In that case,
`accountsChanged` also reports an empty account list, before `chainChanged`, and permissioned
methods remain unavailable until the user grants access on the new chain. An origin whose grant
matches the new chain receives `accountsChanged` with the active address after `networkChanged`.
An origin whose grant matches neither chain receives only the chain and network events.

When `switchChain()` or `switchNetwork()` changes the active chain, the requesting origin's grant
moves with it before any event is sent. That origin receives `chainChanged`, `networkChanged`, and
then `accountsChanged` with the address on the new chain, never an empty list. Other origins are
notified according to their own grants. If the wallet is already on the requested chain, no chain
event is sent.
