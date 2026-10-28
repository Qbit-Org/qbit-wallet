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

Qbit Wallet emits both events after the active chain changes, whether the change originated from
the provider or wallet controls. Read both values again before preparing another request.

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
`accountsChanged` also reports an empty account list, and permissioned methods remain unavailable
until the user grants access on the new chain.
