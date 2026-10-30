# Qbit Wallet release notes

Issue numbers in parentheses, such as (#339), refer to the project's
earlier, private tracker, not to issues or pull requests in this repository.

## 1.0.7

### Sending and fees

- The send screen's fee bar and its abnormal-fee warning now use the same
  fee quote, and the estimated fee groups its digits for your language (for
  example 1,544,000 bits), so a very large fee is easier to spot. When fee
  estimates cannot be read, you can still set a custom fee rate.
- The send and consolidation screens wait until the fee rate comes from the
  current fee estimate. Until then they show the fee and total as pending, so
  nothing can be sent or consolidated at a placeholder rate or at the previous
  network's rate.
- Speed up now checks twice, ignoring cached answers, that no later payment
  depends on the transaction it replaces. A send retried after the wallet
  restarts is checked the same way before it goes out.
- On a slow connection, sending, checking a payment's status, speeding up a
  payment and consolidating no longer hang for up to 15 minutes. Each now ends
  within its own time limit and keeps an unknown outcome unknown, and a Speed
  up no longer fails after you have approved it.
- Retrying a payment whose outcome was unknown can no longer mark it "not
  sent" and free its coins while the first attempt may still be spending them.

### Balance

- The balance no longer stalls while a payment is being broadcast: it briefly
  shows Available and Unavailable as `--`.
- Accounts with more than 500 outputs now see their real Available and
  Unavailable amounts once the wallet has read their outputs. The send screen
  no longer shows the whole balance as Unavailable while the split is unknown.
- On mempool-qbit, accounts whose pending transactions fill whole history
  pages can be read in full again, for sending, restoring, recovery and
  activity history. Recovery sets aside, and names, a source it still cannot
  read instead of stopping, and the balance shows `--` instead of 0 until it
  has been read.

### Websites and approvals

- A website can switch Qbit chains after you unlock the wallet, the
  network-switch approval screen opens again, and the wallet-connect library
  connects before it asks to switch chains.
- A website request now ends when the page that sent it is closed, so an
  approval left open for a closed page can no longer sign or send anything.
  Opening the wallet from the toolbar no longer cancels a site's pending
  unlock request, and the wallet tells you when opening it does cancel one.
- Website PSBT approvals:
  - They say whether the site gets a transaction it can broadcast right away,
    once its lock time has passed, or once the coins it spends are old enough.
  - They show the transaction's lock time, its inputs' relative locks and its
    version.
  - They mark the outputs that come back to you or to another of your accounts.
  - They describe a signed but unfinalized result as needing the site or other
    signers to finalize it.
- Website PSBT approvals ask you to confirm a fee that is a large share of
  the payment, even when the estimated fee rate looks normal. This covers the
  1.0.6 limitation for transactions that also spend coins not held at the
  wallet's own addresses.
- Connected websites are saved in a format the wallet controls, and a problem
  loading them no longer keeps the rest of the wallet, including phishing
  protection, from starting. Websites you connected in 1.0.6 stay connected.

### Phishing protection

- Phishing protection diagnostics report protection as degraded while a
  site-access change is still being applied or the block rule is not
  installed.
- A link to a blocked site that opens in a new tab shows the warning there
  without replacing the page you came from.
- The warning screen offers Continue only for addresses it can open, and says
  why otherwise.

### Restoring a wallet

- Restoring a wallet can no longer take a signature-counter floor from an
  explorer that claims impossible or extreme address statistics, which could
  have left the wallet unable to sign until it was restored again.

### Settings and contacts

- If a change to sign-data requests or the auto-lock time cannot be saved, the
  wallet tries again to save the previous value. If that fails too, it says
  the stored setting may have changed, instead of implying the old value will
  still apply after a restart.
- If the wallet cannot read its stored settings when it starts, it shows an
  error screen with Retry instead of an empty window, and Retry never
  overwrites what is stored.
- Changing a contact's address or network is a single save, so a failed save
  no longer loses the contact. A failed reorder says so and shows the saved
  order.

### Repository and release

- A high-severity advisory published during the release, for a URL-decoding
  package reached only through build and test tooling, is cleared by removing
  those paths. The packaged extension is byte-identical to the build before
  the change.

### Known limitations

- The Available and Unavailable amounts of an account with more than 500
  outputs come from the last read of its outputs. Any new transaction for the
  address makes them unknown (`--`) again until the send screen reads its
  outputs, so a busy address rarely shows them.
- Speed up, and a send retried after the wallet restarts, are refused rather
  than sent when the explorer is slow (more than about 5 seconds a read) or
  has not yet indexed a funding transaction. Try again later.

## 1.0.6

### Sending and fees

- A send whose broadcast outcome is unknown no longer keeps its funds
  unavailable, or blocks Speed up, until the browser restarts. Once the
  wallet finds the transaction pending, or you leave the recovery screen,
  Speed up works. The funds come back once it finds the transaction gone,
  and the balance card and the send screen now agree on what is
  available (#339).
- A send whose broadcast hits a transient error (a gateway error, a timeout
  after sending, or a reply that is not the transaction's identifier) is no
  longer left as "outcome unknown" at once. Once a lookup shows the network
  does not have it, the wallet sends the same signed transaction again, at
  most twice, and starts no re-send more than 30 seconds after the first
  attempt. This applies to website broadcasts too (#356).
- A fee bump is checked again, right before it is broadcast, for payments
  that spend the original transaction, including one made from another
  device or by a recipient while the confirmation screen was open, and when
  it is retried after the wallet restarts in the background. Such a bump is
  refused instead of cancelling that payment (#340).
- A send that would spend the change of a large unconfirmed send together
  with many other inputs is refused before signing, with a message to wait
  for the earlier send to confirm or send less. qbit nodes reject a chain of
  unconfirmed transactions over 404 kB, so such a send used to be signed and
  then rejected. The wallet now spends that change only in a send small
  enough to fit (#345).

### Balance

- When the explorer cannot be reached, the balance card says so instead of
  showing a balance of 0. If no balance has loaded, the card turns grey and
  says the balance could not be loaded, with Try again. If a later refresh
  fails, the card keeps the last balance and says it may be out of date. Try
  again fetches at once, and the warning clears on the next refresh that
  succeeds. A refresh that finishes late no longer replaces the balance or
  error of a newer one. The card's label now reads "Wallet Balance". Until
  the first balance arrives, the card shows it as loading instead of 0, or
  keeps it masked while the balance is hidden. If the explorer does not
  answer at all, the error appears after about 45 seconds.

### Accounts with many outputs

- The balance card of an address holding more outputs than the explorer
  will list shows its Available and Unavailable amounts as unknown (`--`)
  instead of 0 and the whole total, with a line saying why, as the send
  screen does. The total still comes from the address statistics (#341).
- Switching accounts while the send screen is still reading the outputs of
  an account with many outputs no longer leaves the next account's send
  screen showing 0 available. Each account's outputs are kept for that
  account only, a slow read that lands late no longer replaces them, and
  opening Send again while a read for the same address state is running joins
  it instead of starting another (#342).
- Consolidation now finds an account's mature outputs when a full page of
  its transactions is still pending, instead of saying nothing is ready
  (#343).
- Large history pages and transactions now load on slow connections. The
  explorer must still start answering within 15 s, and a download that
  stops sending data for 15 s is still cut off and retried. One that keeps
  arriving may take up to 5 minutes per try instead of failing after 15 s
  (#353). A read is tried up to three times, so a page that arrives too
  slowly can take about 15 minutes to fail, and a screen that waits for it,
  such as Prepare on the consolidation screen, waits as long.

### Websites and approvals

- A website broadcast through `pushTx` or `pushPsbt` whose result is unknown
  is looked up instead of reported as failed: the website gets the
  transaction's identifier when it is found, or a distinct "outcome unknown"
  error naming the transaction to check before retrying. The inputs of a
  transaction the user approved signing for a website stay reserved until
  the result is known (#268).
- Transaction approvals and the send screen show the amount leaving the
  wallet, fee included, ahead of the transaction details, and warn when the
  fee is far above the recommended rate, at least 100 times the network
  minimum, or a large share of the amount sent. Outputs to addresses the
  wallet does not recognise are marked. Signing an abnormal fee, or an output
  beside the recipient a request names, needs an explicit confirmation
  (#271).
- Account and network events reach only the websites they concern (#270).
  Switching networks no longer tells every connected website it lost access.
  A website connected on the new network receives its account, and a website
  that asked for the switch stays connected. Turning on quick multi-sign for
  one website no longer sends a network change to every website. Websites
  built with the wallet-connect React library no longer revoke their own
  access when the wallet reports no account.
- Signing several transactions at once with quick multi-sign now checks
  each one for an abnormal fee and for outputs to addresses the wallet does
  not recognise, as a single approval does. The flagged transactions are
  named, and none of the batch is signed until you confirm their risks
  (#367).
- A website transaction that lists the account's spending script more than
  once on an input, or with a Merkle proof that does not match the coin it
  spends, is refused before the approval opens. It used to fail only after
  the user approved it, using up one post-quantum signature (#352).

### Phishing protection

- A page on the phishing denylist now shows the wallet's warning, with
  Proceed, however the tab got there: through a redirect, a link wrapper
  such as t.co or a mail safe-link, a typed URL or a bookmark. Before, only
  a link the wallet saw first led to the warning, and everything else ended
  on the browser's "blocked by an extension" page. The extension now asks
  for access to the denylisted sites, which adds no new install warning. If
  you restrict the wallet's site access in Chrome, you get the browser's
  blocked page as before (#348). If the wallet cannot remove its redirect
  rule, a denylisted page can load until it does.
- If the phishing block rule fails to install when the wallet starts, the
  wallet now retries it, removes the unused redirect rules of 1.0.4, and
  reports the rule's state to its diagnostics. Until the rule is in place,
  the wallet stops a page on its phishing denylist before the page's own
  script can run, and shows its warning instead (#349). This needs the
  wallet's site access in Chrome: with "On click" or "On specific sites", a
  denylisted page can load until the rule is installed.

### Keys and vault

- Locking and unlocking the wallet while a signature or account change is
  waiting no longer loses it: the signature is refused instead of being
  released without its post-quantum signing count saved, and an account
  change reports an error instead of success. Retry it once the wallet is
  unlocked (#350).

### Restoring a wallet

- A restored wallet whose address has too long a history to read in full
  (over 6,400 transactions, or more pending transactions than an Esplora
  explorer lists) is no longer sign-locked for good. Its signature-counter
  floor comes from the explorer's address statistics, the same count the
  full read checks against, and the restore report names the accounts read
  that way (#264).
- A recovery migration no longer stalls on an account with more than 10,000
  transactions. The other accounts move as usual, the migration screen names
  that account, and it can consolidate its outputs during the migration so
  that a later pass moves them (#344). One case still stops the whole pass:
  on a mempool-qbit explorer, an account over the explorer's output limit
  whose pending transactions fill whole history pages (a multiple of 50)
  cannot be read until one of them confirms or another arrives.

### Settings and contacts

- Changes to sign-data requests, the auto-lock time and replace-by-fee are
  saved before the setting reports success, so quitting the browser or
  reloading the extension straight afterwards no longer restores the old
  value (#283).
- If the wallet cannot read its stored settings when it starts, it no longer
  replaces them with defaults (#283).
- Default wallet and account names are saved, and a contact edit that cannot
  be saved shows an error instead of disappearing after a restart (#283).

### Repository and release

- The extension ZIP no longer depends on the directory it is built in.
  Earlier builds embedded the builder's checkout path in `background.js`, so
  an independent rebuild matched the CI artifact only from the same path.
  Packaging now fails when packaged text contains a `file:///` URL or a path
  inside the builder's checkout or home directory (#338).

### Known limitations

- For a transaction a website asks the wallet to sign that also spends coins
  not held at the wallet's own addresses, the fee rate is an estimate and can
  be shown lower than it is, so the fee warning and its confirmation may not
  appear. The fee and the amount leaving the wallet, shown first, are exact.
- If the wallet's site access in Chrome is set to "On click" or "On specific
  sites", a denylisted page can load while the wallet's phishing block rule
  is not installed, or while the wallet cannot remove its redirect rule.
- On a slow connection, Speed up can be refused for a large transaction.
  Right before it broadcasts a fee bump, the wallet reads the original
  transaction again and asks what spends it, within 10 seconds for both. An
  original with about 100 inputs is about 400 kB, which the explorer sends
  as about 800 kB of hex, usually compressed to about 460 kB, so on a
  connection slower than about 0.4 Mbit/s it does not arrive in time.
  Nothing is sent, and the original transaction stays as it was.

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
