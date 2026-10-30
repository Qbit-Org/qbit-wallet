# Connect to Qbit Wallet

Connecting grants the page's exact origin access to the active Qbit account on the active Qbit
chain. The grant is persisted by Qbit Wallet and does not authorize a different origin or chain.

Call `requestAccounts()` only after a direct user action, such as a button click. Disable the
button while the promise is pending, and never open a connection approval automatically on page
load.

## `requestAccounts()`

```typescript
requestAccounts(): Promise<string[]>;
```

Qbit Wallet shows the user the exact requesting origin, account, chain, and network. If approved,
the method persists the chain-scoped grant and returns an array containing the active address.
V1 currently exposes at most one address.

```javascript
const button = document.querySelector('#connect-qbit')

button.addEventListener('click', async () => {
  button.disabled = true

  try {
    const [address] = await window.qbit.requestAccounts()
    console.log('Connected Qbit address:', address)
  } catch (error) {
    console.error('Qbit connection was not approved', error)
  } finally {
    button.disabled = false
  }
})
```

The origin shown by Qbit Wallet comes from the browser tab. A dapp cannot override it with request
parameters.

If the user changes the active chain inside Qbit Wallet, the old chain grant does not authorize
the new chain. `getAccounts()` then returns an empty array and the dapp must request access again
from a user action. The grant for the old chain is kept: when the wallet returns to that chain, the
origin can read its account again and receives `accountsChanged` with it. A provider-driven chain
switch that the user approves updates that origin's grant to the new chain.

## `disconnect()`

```typescript
disconnect(): Promise<void>;
```

`disconnect()` revokes and persists removal of the current origin's grant. It never opens a
connection approval, including when the origin is already disconnected.

```javascript
await window.qbit.disconnect()
```

During revocation, subscribed pages receive `accountsChanged` with an empty array and then the
`disconnect` event. Treat either signal as a reason to clear account-derived application state.
An empty `accountsChanged` without `disconnect` means the wallet is on a chain this origin has no
grant for. Do not call `disconnect()` in response to an event: it revokes the grant, and only an
explicit user action should do that.

```javascript
function handleDisconnect() {
  clearConnectedAccountState()
}

window.qbit.on('disconnect', handleDisconnect)

// When the component is disposed:
window.qbit.removeListener('disconnect', handleDisconnect)
```

The same persisted revocation behavior applies when the user disconnects the site in Qbit Wallet
settings.
