# Browser detection

Qbit Wallet exposes one provider at `window.qbit` in the top-level page context.

Do not assign to or predefine this property. Qbit Wallet installs its provider as a non-writable,
non-configurable property. If a page locks a look-alike object in that location before injection,
Qbit Wallet fails closed instead of treating the look-alike as its provider.

```javascript
function getQbitProvider() {
  const provider = window.qbit

  if (
    !provider ||
    typeof provider.requestAccounts !== 'function' ||
    typeof provider.getChain !== 'function' ||
    typeof provider.on !== 'function'
  ) {
    return null
  }

  return provider
}

const qbit = getQbitProvider()
if (!qbit) {
  console.log('Qbit Wallet is not available')
}
```

Treat this as feature detection, not authentication. A web page controls its own JavaScript
environment and can create look-alike objects. Establish wallet access only by calling
`requestAccounts()` in response to a user action and allowing Qbit Wallet to show its connection
approval. Never accept an origin, account, chain, or network supplied by another script as a
substitute for values returned by the provider.

Do not search for alternate globals and do not call undocumented properties. The complete public
surface is listed in the [provider reference](./README.md#canonical-v1-surface).
