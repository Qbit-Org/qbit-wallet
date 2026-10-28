# Qbit Wallet release notes

## 1.0.5

### Sending and fees

- Coin selection ranks inputs by value after the per-input fee, so sends no
  longer pull in small inputs that cost more than they add or report
  "Insufficient balance" when the balance covers the payment (#275).
- Sends, send-all and recovery sweeps stay within the standard transaction
  size. Send-all uses the highest-value inputs that fit and says what is left
  behind; recovery sweeps split into value-balanced batches (#276).
- The wallet spends confirmed outputs and its own unconfirmed change, and no
  longer spends unconfirmed outputs received from others (#279).
- A fee bump is refused when a later payment from the account depends on the
  original transaction, instead of silently cancelling that payment (#274).
- A fee bump is bound to the transaction the account signed (#261).
- Inputs of a just-broadcast transaction stay reserved, and a send whose
  broadcast result is unknown is reconciled instead of reported as failed
  (#278; part of #268). A website send rejected after signing releases its
  inputs straight away (#269).

### Accounts with many outputs

- An address holding more outputs than the explorer will list (#277) shows
  its total balance from the address summary, labelled as such, instead of 0.
  The wallet works out the spendable outputs from the address history, can
  consolidate them in standard-size batches, and can migrate them during
  recovery. See `docs/explorer-utxo-limit.md` and the known limitations
  below.

### Websites and approvals

- Phishing blocking works under Manifest V3: navigations to denylisted sites
  are blocked, a click on a denylisted link always lands on the warning page,
  and Proceed lets the site load for the rest of the browser session
  (#266, #320). Even after Proceed, a denylisted site and its subdomains get
  no wallet provider, and the approval screens only let the user reject their
  connection and signing requests. This includes a subdomain whose name is not
  valid DNS, such as `a_b.<site>` (#335).
- Each approval carries an id, so an approval window can settle only the
  request it shows (#311). Unlocking the wallet settles only the unlock
  request (#267).
- Website sessions are bound to the origin Chrome reports for the connection
  (#265), and only the wallet's own pages can open UI connections (#259).

### Websites and integrators

Some requests that 1.0.4 accepted are now refused or answered differently.

- `signPsbt` and `signPsbts` refuse the following before the approval opens
  and before any signature counter moves (#272, #329):
  - an input whose `PSBT_IN_SIGHASH_TYPE` is anything but the default (1.0.4
    ignored the field and signed with the default);
  - an output other than P2MR, OP_RETURN or P2A, which qbit Core does not
    allow;
  - a malformed PSBT: non-canonical compact sizes, malformed proprietary keys,
    out-of-range amounts, outputs worth more than the inputs, or duplicate
    keys;
  - a PSBT over 16 MiB, or with more than 131,072 inputs, outputs and map
    entries combined;
  - options that are not an object, carry a key other than `chain` and
    `autoFinalized`, or have a non-boolean `autoFinalized`. These fail with
    `-32602`. 1.0.4 ignored unknown keys such as `toSignInputs` and signed
    every matching input.
- A `signPsbts` call without one options entry for each of its 1 to 20 PSBTs
  fails with `-32602` instead of `4901`.
- `sendQbit` reports an unknown broadcast outcome with the new error
  `-32010` and `data: { outcome: 'unknown', chain, txid }`. The website should
  look that transaction up instead of retrying, which could pay twice. A
  transaction the wallet's follow-up lookup finds resolves with its txid
  (#268). See `docs/api/sign-transaction.md`.
- `pushTx`, `pushPsbt`, `signPsbt` and `signPsbts` refuse a transaction that
  spends an input a recent broadcast of another transaction spent, so a
  pending transaction cannot be replaced through them (#278).
- A second website request for a transaction that another request is already
  sending is refused (#269).
- A website PSBT is finalized only when the wallet's signatures complete it
  (#272). With `autoFinalized` omitted, a PSBT the wallet cannot complete
  comes back signed but not finalized. An explicit `autoFinalized: true` that
  the wallet cannot meet is refused with `-32602` before the approval.
- Some PSBTs that 1.0.4 could not finalize now finalize, such as one with
  another key's signature on the account's input. A finalized PSBT keeps the
  input fields qbit Core keeps, including the non-witness UTXO and unknown and
  proprietary fields. The extracted transaction is unchanged (#329).
- `signMessage` refuses a message containing an unpaired UTF-16 surrogate.
  `verifyMessage` returns false for such a message, and for a proof address
  that is not in its canonical lowercase spelling (#329).
- `qbit:` URIs on the receive screen encode spaces in the label as `%20`.
- The explorer client from the npm SDK behaves differently (#329):
  - It follows no redirects.
  - Each attempt must receive the whole response, body included, within 15
    seconds, so a very large history page on a slow connection can fail where
    1.0.4 was only slow.
  - It no longer re-sends a transaction after a timeout, network error or
    server error. The wallet looks the transaction up instead.

### App Center

- The DApp Center is now the App Center in every locale. Its pool entries are
  now "Qbit Pool" and "Qbit Testnet Pool". They open
  `https://qbit.org/pool` and `https://qbit.org/pool?network=testnet4`
  instead of prismpool.io (#325).

### Keys and vault

- Unlocking no longer replaces the stored vault while the keyrings rebuild
  (#260), and a failed account or keyring change no longer rolls the vault
  back to an older copy. Post-quantum signing counters only move forward
  (#263).

### Recovery migration

- A failed migration step shows an error code and details that can be copied
  into a support request (#258).

### Repository and release

- The wallet workspace packages are private and are not published to npm
  (#289). Security reporting goes through `SECURITY.md` (#291).
- Release-gate, risk-register and privacy docs describe the controls as they
  are enforced (#292).
- CI and the Playwright gate run on pull requests into release branches, the
  release token is kept away from install-time code, and dependency
  advisories are cleared (#262, #252).
- The SDK and PQC packages now come from npm: `@qbit-oss/pqc`,
  `@qbit-oss/protocol` and `@qbit-oss/api` 0.1.0, published with provenance
  from the signed `v0.1.0` tags of the public Qbit-Org repositories. The
  repository no longer has Git submodules (#96, #288).

### Known limitations

- A website broadcast through `pushTx` or `pushPsbt` whose result is unknown,
  after a timeout, a server error or a lost connection, comes back to the
  website as an ordinary error, and its inputs are not reserved. A website
  that treats it as failed and asks for a new transaction can make the user
  pay twice. 1.0.4 behaved the same. The wallet's own sends look the
  transaction up instead, and `sendQbit` rejects with `-32010` naming the
  transaction to check (#268).
- For an address over the explorer's limit, the balance card's details show
  Available as 0 and the whole balance as Unavailable, although the spendable
  amount is not known. The send screen shows it as unknown (#341).
- Input reservations and send claims are kept in memory only. A restart of
  the wallet's background, from a browser restart, a crash or an extension
  update, drops them. Until the explorer shows a just-sent transaction, a new
  send can then pick its inputs and conflict with it. Retrying a send from the
  wallet re-sends the same transaction. A website `sendQbit` cut off during
  its broadcast gets a disconnect, not an "outcome unknown" error.
- Consolidate an account that is over the explorer's limit before starting
  recovery. Once a migration has begun, consolidation is refused and the
  migration cannot be cancelled, and a source whose history is too long to
  read stops the whole migration from being prepared. See
  `docs/explorer-utxo-limit.md` (#344).

## 1.0.4

- The extension is named "Qbit Wallet" in every locale, without the Satflow
  byline; the manifest gives an author email and links its homepage to qbit.org.

## 1.0.3 and earlier

### Qbit network

- Qbit mainnet, testnet4, and regtest are the supported wallet networks.
- Address derivation binds Qbit network identity and the connected public key
  into the documented PQC context.
- Receive flows track address-use floors and protect against unsafe address
  reuse.
- Transaction creation, fee review, P2MR signing, replacement, and history are
  expressed in Qbit-native units and contracts.

### Provider

- Sites connect through `window.qbit`.
- Account, network, message-signing, transaction-signing, and Qbit send requests
  use Qbit provider contracts.
- Approval screens display transaction intent, fees, outputs, and signing risks
  before a request can proceed.

### Extension

- The browser extension, package namespaces, workspace filters, build artifacts,
  test fixtures, and user-facing copy use the Qbit identity.
- The wallet home, receive, send, history, settings, and account flows focus on
  the Qbit coin and Qbit networks.
- Website-safety checks use a bundled, versioned policy and fail closed when a
  remote check cannot be completed safely.

### Engineering

- Signing, derivation, address, serialization, API, provider-routing, and
  extension-build regression coverage is part of the release gate.
- Qbit protocol packages are pinned as workspace submodules and verified by the
  conformance scripts.
- Release builds support deterministic artifact verification.
