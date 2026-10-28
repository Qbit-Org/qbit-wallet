# Qbit Wallet dapp provider

Qbit Wallet injects one canonical provider at `window.qbit`. A dapp uses this provider to request
chain-scoped account access, inspect the active Qbit chain, create P2MR signatures, sign Qbit
PSBTs, and broadcast Qbit transactions.

## Start here

1. [Detect the provider](./browser-detection.md).
2. [Request account access](./connect-extension.md) from a user action.
3. [Read the active account](./access-accounts.md).
4. [Bind requests to the active chain](./manage-networks.md).
5. [Sign and verify a P2MR message](./sign-message.md).
6. [Sign or broadcast a Qbit transaction](./sign-transaction.md).

## Canonical V1 surface

| Area               | Methods                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| Connection         | `requestAccounts()`, `disconnect()`                                             |
| Account            | `getAccounts()`, `getPublicKey()`, `getBalance()`                               |
| Chain              | `getNetwork()`, `switchNetwork(network)`, `getChain()`, `switchChain(chain)`    |
| Message            | `signMessage(text)`, `verifyMessage(address, text, proof)`                      |
| Transaction        | `signPsbt(psbtHex, options)`, `signPsbts(psbtHexs, options)`                    |
| Broadcast and send | `pushPsbt(psbtHex)`, `pushTx(rawHex)`, `sendQbit(toAddress, satoshis, options)` |
| Events             | `on(event, handler)`, `removeListener(event, handler)`                          |

The only public events are `accountsChanged`, `networkChanged`, `chainChanged`, and `disconnect`.
No additional public methods or events are part of the V1 contract.

## Chains and networks

```typescript
type QbitChain = 'QBIT_MAINNET' | 'QBIT_TESTNET4' | 'QBIT_REGTEST'
type QbitNetwork = 'mainnet' | 'testnet4' | 'regtest'
```

Every account grant belongs to the exact requesting origin and active chain. `requestAccounts()`
creates that grant. `getNetwork()`, `getChain()`, `verifyMessage()`, and `disconnect()` can be
called without one; every other method requires a persisted grant matching the wallet's current
chain. Qbit PSBT bytes do not identify a chain, so `signPsbt()` and every `signPsbts()` item
require an explicit `chain` option that must match both the active chain and the origin's grant.

Signing approvals bind the exact trusted origin, account, chain, network, and payload reviewed by
the user. A request is rejected if any bound value changes before signing completes.

## Reference

| Topic                                       | Description                                            |
| ------------------------------------------- | ------------------------------------------------------ |
| [Browser detection](./browser-detection.md) | Find and minimally validate `window.qbit`              |
| [Connect extension](./connect-extension.md) | Grant and revoke chain-scoped origin access            |
| [Access accounts](./access-accounts.md)     | Read the active address, public key, and balance       |
| [Manage networks](./manage-networks.md)     | Read or switch Qbit chains and handle change events    |
| [Sign message](./sign-message.md)           | Create and locally verify a structured P2MR proof      |
| [Sign transaction](./sign-transaction.md)   | Sign Qbit PSBTs, send Qbit, and broadcast transactions |
