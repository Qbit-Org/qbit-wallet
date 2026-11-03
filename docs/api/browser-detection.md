# Browser detection

Qbit Wallet exposes one provider at `window.qbit` in each page it clears, and a separate one in each
cleared frame of that page, such as an embedded widget. A sandboxed frame, whose origin is opaque,
gets no provider.

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

## Wait for the wallet

Qbit Wallet installs `window.qbit` only after it has checked the page, so the provider may be
missing when a page script first runs. Once it is installed, Qbit Wallet dispatches two events on
`window`:

1. `qbit#initialized`, a plain `Event`, once.
2. `qbit:announceProvider`, a `CustomEvent`, right after it, and again each time the page
   dispatches `qbit:requestProvider`. A script that starts listening late asks this way.

The announcement follows the shape of EIP-6963. Its `detail` and `detail.info` are frozen:

| Field       | Value                                    |
| ----------- | ---------------------------------------- |
| `info.uuid` | A version 4 UUID, new for each page load |
| `info.name` | `Qbit Wallet`                            |
| `info.icon` | The wallet's icon as a `data:` URI       |
| `info.rdns` | `org.qbit.wallet`                        |
| `provider`  | The provider installed at `window.qbit`  |

```javascript
// As long as @qbit/wallet-connect waits: while the wallet's service worker
// starts, the provider can take several seconds to arrive.
function waitForQbitProvider(timeoutMs = 5500) {
  return new Promise(resolve => {
    const events = ['qbit#initialized', 'qbit:announceProvider']
    const finish = provider => {
      clearTimeout(timer)
      events.forEach(type => window.removeEventListener(type, check))
      resolve(provider)
    }
    const check = () => {
      const provider = getQbitProvider()
      if (provider) finish(provider)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    events.forEach(type => window.addEventListener(type, check))
    // Asks again, in case Qbit Wallet announced before this script listened.
    window.dispatchEvent(new Event('qbit:requestProvider'))
    check()
  })
}

waitForQbitProvider().then(provider => {
  if (!provider) {
    console.log('Qbit Wallet is not available')
  }
})
```

These events are for detection, not authentication. Any script on the page can dispatch them, with
any `detail`, so an event only tells you when to look at `window.qbit` again. Use `info` to show
Qbit Wallet in a list of wallets, but take the provider from `window.qbit`, which no script can
replace once Qbit Wallet has installed it, and establish access only through `requestAccounts()`.

Each page or frame that gets a provider gets its own events and its own `uuid`. Events do not cross
frames, so a script listens in its own frame. A page that Qbit Wallet has not cleared, such as a
denylisted site, gets no provider and neither event.
