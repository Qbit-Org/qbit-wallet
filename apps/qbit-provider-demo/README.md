# Qbit V1 provider demo

This dependency-free fixture exercises the canonical `window.qbit` provider from a real,
stable web origin. It is intentionally local-only and restricted to `QBIT_TESTNET4`.

## Run locally

Build and load the development extension, then serve this directory from the repository root:

```sh
python3 -m http.server 4173 --directory apps/qbit-provider-demo
```

Open `http://127.0.0.1:4173`. Do not open `index.html` directly: a `file:` page has an opaque
origin and cannot demonstrate origin-bound permission persistence correctly.

The application logic makes no outbound HTTP or RPC requests. The only network-changing action
is the explicit **Broadcast signed PSBT** button, which calls `window.qbit.pushPsbt(...)` through
the extension after a separate confirmation checkbox is selected.

Provider detection requires the full V1 method list plus the immutable, non-replaceable
`window.qbit` descriptor installed by the extension. A page cannot cryptographically prove who
created a JavaScript object, so the extension itself also fails closed when an earlier
non-configurable page spoof prevents canonical injection.

## End-to-end flow

1. Detect `window.qbit` and select **Connect**. Confirm that the wallet approval shows the exact
   origin rendered at the top of the page.
2. Confirm or switch the active chain to `QBIT_TESTNET4`.
3. Select **Sign message**, inspect the versioned P2MR proof, then select **Verify proof**. The demo
   calls `verifyMessage(account, exactMessage, proof)`.
4. Paste a funded Testnet4 P2MR PSBT whose signing leaf contains the connected account's public
   key. Select **Sign PSBT on Testnet4**. The call binds the request explicitly:

   ```js
   await window.qbit.signPsbt(psbtHex, {
     chain: 'QBIT_TESTNET4',
     autoFinalized: true,
   })
   ```

5. Review the signed PSBT, acknowledge the Testnet4 broadcast target, and select
   **Broadcast signed PSBT**.
6. Select **Revoke & disconnect**. The event log should show `accountsChanged` with an empty array
   and `disconnect`. Reloading the page and calling `getAccounts()` should still return an empty
   array until this origin reconnects.

The page also records `networkChanged` and `chainChanged`. Any account, network, or chain event
invalidates the displayed proof and signed PSBT so a result cannot be reused under changed
context.

## Deterministic PSBT fixture

**Load deterministic format fixture** inserts a compact unsigned P2MR PSBT derived from
`packages/protocol/test/p2mr-psbt-signing.test.ts` in
[Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/protocol/test/p2mr-psbt-signing.test.ts):

- input value: 100,000 base units;
- output value: 90,000 base units;
- signer public key: `01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da`;
- fictional previous transaction ID: 32 bytes of `09`.

It is a valid protocol-format fixture, not a spendable transaction. A wallet should sign it only
when its active public key matches the fixture, and a network must reject its nonexistent
previous output. For a successful sign-and-broadcast run, replace it with a funded PSBT created
for the connected Testnet4 account.

## Safety properties

- All state is held in memory and is cleared by reload or disconnect.
- No private keys, seed phrases, or signer state are requested or stored.
- Message and PSBT results are discarded if their reviewed input, account, or chain changes while
  approval is open.
- Broadcasting is never automatic and is checked against the live `QBIT_TESTNET4` chain immediately
  before submission.
- The fixture uses only the canonical Qbit V1 provider and P2MR message contract.
