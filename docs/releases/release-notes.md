# Qbit Wallet release notes

In 1.0.6 and earlier, issue numbers in parentheses, such as (#339), refer to
the project's earlier, private tracker, not to issues or pull requests in this
repository. From 1.0.8, issue numbers such as #30 refer to issues in this
repository.

## 1.0.9

### Sending and fees

- An amount that needs more than 106 of an account's outputs can now be sent
  with one confirmation (#188). Before, the send screen refused it, and MAX
  sent only the 106 largest outputs. The wallet first combines the account's
  funds with transactions that pay its own address, then pays the recipient
  with one transaction once they confirm. The send screen says how many
  transactions it takes, exactly what the recipient receives, the total fee
  and about how long signing takes, and the review shows them again before
  you confirm. MAX sends the whole confirmed balance this way, less the
  fees, and says what stays in the account because it is worth less than
  the fee to send it, and what has not confirmed yet and is not included.
  When one transaction of the largest outputs, change not confirmed yet
  included, sends at least as much, MAX sends that one transaction instead.
  If the balance cannot pay the amount and every fee, the send screen
  offers the largest amount it can send, for you to choose. While such a
  payment is in progress, MAX sends one transaction of the funds it does
  not hold, as before, and the send screen links to that payment; an amount
  that needs the funds combined waits until that payment is done.
- Signing such a payment takes minutes, one signature for each output it
  spends, and goes on if you close the wallet window; a card on the home
  screen leads back to its progress. An auto-lock that falls due while it
  signs waits until the signing ends, also with no wallet window open, but
  never longer than 10 minutes plus twice the time the signing was expected
  to take. Any other lock pauses the signing until you unlock it. The
  payment itself goes out when the combined funds confirm, also while the
  wallet is locked. Nothing reaches the recipient before then, and if
  something stops the payment, the wallet says where your funds are: in your
  wallet, partly or fully combined.
- If one of the combining transactions stays unconfirmed for 30 minutes, or
  the network refuses the payment for its fee, the progress view offers to
  raise the fee. You review the new total fee and confirm once. An exact
  amount never changes; for a payment of the whole balance the review states
  the new amount beside the old one.
- The minimum fee rate is now 0.25 bits/vB, down from 1 bit/vB. It is the
  lowest rate that qbit Core nodes relay. A payment that spends one input cost
  at least 3,817 bits before and costs at least 955 bits now. When the network
  is quiet, Slow can go down to 0.25 bits/vB and Normal to 0.5, and Fast stays
  at 1 bit/vB or more. A Custom rate can be set from 0.25. Below that, Next
  stays disabled and the screen says "The minimum fee rate is 0.25 bits/vB."
  A fee rate that a website asks for is accepted from 0.25 as well.
- When fee estimates are unavailable, the wallet still uses 1 bit/vB and says
  so. Speed up still raises the rate by at least 1 bit/vB, and a recovery
  migration still pays at least 1 bit/vB.
- A fee rate that the wallet works out from a fee and a size, in an approval,
  in Speed up or in the history, is rounded down, so it never reads higher
  than the rate paid.
- Signing a transaction with many inputs now shows its progress. Each input
  needs its own signature, and 106 inputs took about a minute and a half to
  sign on a test machine. From 4 inputs, the review gives way to a "Signing
  transaction" screen with a progress bar, a count such as "42 of 106 inputs
  signed", the time left and a "Keep the wallet open" notice. Back, Reject and
  Sign stay locked until the signing is done. A transaction with 20 or more
  inputs says before you sign that signing will take a while. Before, the
  screen did not change while the wallet signed, and Sign stayed enabled.
- Closing the wallet while it signs now stops the signing before its next
  input, and nothing is sent. Before, the wallet kept signing in the
  background for a result that could no longer be sent, which held up the
  next send for up to a minute and a half.
- Pressing Sign a second time no longer starts a second signing.
- After signing, the wallet says "Broadcasting transaction…" instead of
  showing a spinner with no text.
- A transaction that the explorer refuses as too large to broadcast is now
  reported as not sent once the wallet has checked that the network does not
  have it, and its coins are free to spend again. Before, it read "Payment
  status unknown" and its coins were set aside for 10 minutes to 24 hours.
- What you enter on the Send screen is no longer saved in the extension's
  local storage: the recipient, amount, memo and fee rate are kept by the open
  wallet window only. Before, they were saved there, also while the wallet
  was locked, and a wallet window that opened or reloaded on the Send screen
  showed them again, also for another account or network. The first wallet
  window that opens after the update removes what earlier versions saved.
  Hidden balances and the expanded or collapsed balance card are still
  remembered, and so is the replace-by-fee choice, as the default for the
  next send (#197).
- Selecting another account or network now clears the Send screen, also when
  you select it in another window while the Send screen is open. A payment
  that Next was still preparing for the earlier account or network is
  dropped: its confirmation does not open, and no error of it is shown.
- Pressing Next again while a payment is still being prepared now opens one
  confirmation, for the last press; before, each press opened its own, one
  behind the other. Leaving the Send screen before the payment is ready no
  longer opens its confirmation.

### Consolidation and accounts with many outputs

- You can now choose the size of a consolidation batch. "Outputs per batch"
  takes a whole number from 2 to 106, the most one transaction can carry, and
  MAX is the default. Before you prepare a batch, the screen shows the fee of
  a full batch of that size and how much more smaller batches cost in total.
  The next batch keeps the size you chose.
- Transactions with 103 to 106 inputs now go through: full consolidation
  batches, MAX sends and large recovery transfers. The explorer refused them
  because of a fault in its size check, which is fixed on the explorer. If an
  explorer still refuses a batch as too large, the wallet says that it was not
  sent, and you can prepare a smaller batch.
- The wallet now recognizes the answer that the explorer gives for an account
  with more outputs than it lists. Since the explorer changed that answer,
  such an account showed the explorer's error and could not send. Its balance
  now comes from the address summary again, and its sends read the outputs
  from the account's history.
- Consolidation now follows the explorer's own answer. An account that the
  explorer lists is told that nothing needs consolidating, however many
  outputs it has, and an account that the explorer still refuses can
  consolidate even when it has fewer outputs than the limit.
- The wallet no longer says that consolidating makes the explorer list an
  account again. Once an address has held more outputs than the explorer's
  limit, the explorer keeps refusing to list it, even after consolidation,
  until its operator raises the limit. Consolidating still merges the outputs
  into fewer, so sends need fewer inputs. The send, balance and recovery
  screens are reworded to match.
- An error on the consolidation screen now shows its message instead of
  "[object Object]".
- A batch that succeeds only after Retry or Check status now offers
  "Consolidate next batch" too, and keeps the batch size.

### Accounts and wallets

- The home screen has one account switcher in place of the wallet chip and
  the account card. The card shows the wallet's color, the wallet name above
  the account name, the wallet's tags and the short address. Tapping the
  address copies it, and tapping anywhere else on the card opens Switch
  Account.
- Switch Account lists every account under its wallet, with a search over
  account names, addresses and wallet names. One tap switches the wallet and
  the account together.
- Wallet actions now sit on the wallet. Its menu has Rename Wallet, Change
  Color and Remove Wallet. A wallet that can add accounts also has "+" and Add
  Account, which open a dialog over Switch Account, and a wallet made from a
  recovery phrase has Backup/Show Seed Phrase. An account's menu has Edit
  Name, Copy Address and, where it applies, Export Private Key. The recovery
  phrase is no longer offered in account menus.
- Each wallet has a color, which Change Color sets from eight choices. New
  wallets are named "Wallet" and a number. The names of existing wallets and
  accounts are not changed.
- Tags mark a wallet as Read Only, Recovered, Archived or Linked to Qbit Cold
  Wallet.
- A wallet whose accounts cannot be listed stays in the list as Invalid. It
  can be renamed and removed, and one made from a recovery phrase can show
  that phrase first, so that it can be backed up. Removing such a wallet
  always failed before.
- With the wallet open in more than one window, a switch, removal, rename,
  color change or recovery-phrase request for a wallet or account that
  another window has since removed or replaced is refused, and the list is
  read again. Before, such a switch could select an empty slot and tell
  connected websites an address that had been removed. The last usable wallet
  cannot be removed, even from two windows at once.
- Removing a wallet that is not the current one leaves the current wallet and
  account as they were, and tells connected websites nothing.
- Removing a wallet also forgets its stored name and color, so a later wallet
  cannot pick them up.
- If the wallet locks while a wallet or an account is being added, the
  addition is saved but not selected, and the earlier selection stays after
  you unlock. Before, connected websites were told the new address while the
  wallet was locked.
- The switcher, its menus and its dialogs work with the keyboard and with
  screen readers.

### Locking and unlocking

- The auto-lock no longer ends a long signing. When the auto-lock time comes
  while a transaction is being signed, the wallet waits for the signing, and
  locks one minute after the signing ends or after its broadcast answers. It
  waits only while the page that asked for the signing is open, and never
  locks more than 10 minutes late. A payment that combines funds first waits
  longer, as described under "Sending and fees". Before, the lock failed the
  signing with an internal error such as "KeyringController - password is not
  a string".
- The lock button, the computer locking and the last window closing still
  lock the wallet at once. A signing that a lock stops now says "The wallet
  locked before signing finished, so nothing was sent. Unlock it and sign
  again."
- The page a first wallet was created or restored in now goes to the unlock
  screen when the wallet locks, like every other wallet page, and so does a
  page that was open before the wallet existed. Before, such a page kept
  showing the send form, the receive screen, the settings and the other
  wallet screens while the wallet was locked; only Home went to the unlock
  screen.
- Opening the wallet now counts as using it. When you open the popup or the
  sidebar, the auto-lock time starts over, as it does when you press a key
  there. Before, a popup opened shortly before the auto-lock time locked a
  few seconds later, while you were looking at it. Opening the wallet in a
  full tab does not count, and neither does a page that a website causes to
  open, such as an approval window or the phishing warning; keys and the
  mouse count there as before.
- Unlocking returns to the send you were filling in. When the wallet locks
  while the send form is open, that page shows the form again once the wallet
  is unlocked, with the recipient, amount, memo and fee choice you left.
  Before, the unlock opened Home, where Send starts an empty form. If the
  account or the network changed in the meantime, the wallet opens Home and
  clears the form. Time spent in another tab or application still counts
  toward the auto-lock.
- Back after an unlock no longer returns to Home or to the unlock screen.
  After a lock on Home the unlock leaves the history as it was, so Back from
  Home does what it did before the lock, and in a tab opened on the wallet it
  leaves the wallet. After a lock on another screen, Back after the unlock
  returns to that screen, except the confirm step of a send, which Home
  replaces so that Back goes to the screen before it, such as the send form,
  and never offers the same transaction to sign again. After a lock on the
  send form, the unlock shows the form again and Back goes where it went
  before the lock. Before, one lock could add up to three unlock screens to
  the history and the unlock added Home twice, so Back kept showing Home or
  the unlock screen and never left the wallet; a tab opened unlocked came back
  to Home the same way.

### Websites and approvals

- `https://qbit.org` is recognized as the official Qbit website. The connect,
  message-signing and PSBT-signing approvals show "Official Qbit website"
  under its address, and "Sign all" on a batch from it skips the notice about
  signing all at once. Every request still needs your approval. Only that
  exact address is recognized: `www.qbit.org`, other subdomains and
  `http://qbit.org` are not.
- A website at `qbit.` followed by a top-level domain other than `org`, such
  as `qbit.io`, or at a subdomain of one, is now treated as phishing. Its
  approvals are blocked, it gets no wallet connection, and the phishing
  warning is shown in place of the page.
- The built-in phishing list now names `qbit.ca`, `qbit.com`, `qbit.io` and
  `qbit.me`. It replaces 29 entries, none of which imitated Qbit. The update
  adds no permission prompt.
- Back on the phishing warning returns to the page you came from. That
  matters for the lookalike sites above, which the wallet stops as their page
  starts to load: without it, Back would load the blocked page and then the
  warning again, every time. In 1.0.8 the same loop could happen for a listed
  site whose blocking rules were missing.

### Restoring a wallet and recovery

- A recovery migration shows the same signing progress for each transfer.
  The lock that protects a new recovery phrase left on screen, 10 minutes
  after the screen opens, now runs only while that phrase exists, so it no
  longer cuts a long migration signing short.

### Qbit Mine

- A new Mine tab, between the wallet tab and the App Center, introduces Qbit
  Mine, and its Open Qbit Mine button opens `qbit.org/mine` in a new browser
  tab. The Mine tab shows a NEW badge until you first open it.
- Qbit Mine is listed in the App Center on Mainnet.

### Balance card and tooltips

- The Unavailable tip now lists as bullets why funds can be unavailable:
  protected assets, unconfirmed transactions, and coinbase maturity of 1,000
  blocks. It no longer points to the UTXO Management Tool. The Send screen
  shows the same tip.
- Tooltips now stay inside the wallet window and follow the light and dark
  themes. Before, a long tooltip was wider than the popup and ran past both
  edges.
- The buttons that hide the balance and refresh it now have tooltips, and
  refresh moves to the card's top-right corner.

### Repository and release

- The transaction library, `bitcoinjs-lib`, moves from 6.1.6 to 6.1.8 for a
  critical advisory (GHSA-8vv3-6qpc-gpw6) in its block and merkle-root code.
  The wallet never calls that code, and the library's PSBT code is unchanged.
- The conformance tests now check the minimum fee rate against a real qbit
  Core node: a payment at the 0.25 bits/vB minimum, its fee rounded up to a
  whole bit, is accepted and mined, and the same payment with a fee one bit
  lower is refused.
- The browser release gate grows from 29 to 53 tests. The new ones cover the
  account switcher, a send at the minimum fee rate, a payment that combines
  an account's 214 outputs before it pays, a lookalike website, Back on the
  phishing warning, the consolidation of an account that the explorer refuses
  to list, a lock on a page opened before the wallet existed, Back around a
  lock and an unlock, the send form shown again after an unlock, and what the
  send form keeps across a reload, a lock and an account or network switch.
- CI skips a pull request's repeated run when the same tree has already
  passed. The dependency policy job always runs.
- The repository's wording check,
  `scripts/security/fresh-chain-language.test.mjs`, is removed, because the
  cleanup it guarded is complete.

### Known limitations

- Closing the wallet while it signs cancels the transaction, and there is no
  cancel button. Clicking outside the popup closes it. For a long signing,
  open the wallet in the sidebar, where it stays open while you use other
  tabs.
- Miners choose which transactions they include, so a payment at a rate close
  to the 0.25 bits/vB minimum can take longer to confirm. Speed up raises such
  a payment to at least 1 bit/vB.
- A payment of the whole balance and a consolidation batch cannot be sped up.
  They wait at the rate they were sent with. If the network's minimum rises
  above that rate, the transaction is dropped, its coins are free again, and
  it can be sent again at a higher rate.
- An address that has once held more outputs than the explorer's limit stays
  unlisted after it consolidates, until the explorer's operator raises the
  limit. An account whose history the wallet cannot read in full either
  cannot send, and Consolidate is still offered to it although it cannot help
  (#169).
- Only the four lookalike sites named above are blocked before the browser
  contacts them. Any other `qbit.` lookalike is stopped as its page starts to
  load, and shows no warning where you have withheld the wallet's access to
  that site, though it still gets no wallet connection. Lookalikes of other
  shapes, such as `qbit-org.com` or `qbit.co.uk`, are not recognized (#33).
- On the phishing warning, Back has nowhere to return to in a tab with no
  earlier page, such as one that another application opened, so the warning
  is shown again.
- Removing a wallet shown as Invalid removes it on every network, even when
  it is invalid only on the current one. Back up its recovery phrase first.
- A lock closes the report shown after a wallet is restored, and a lock while
  the restore is still scanning keeps it from showing at all; it is not shown
  after the unlock. Its notices go with it: that the signature counters were
  rebuilt from on-chain history and are minimums, with the advice to move
  funds to a fresh wallet if the phrase was used in another wallet; the note
  that some counters were rebuilt from the explorer's address totals; the
  warning that address discovery stopped at its scan limit; and the network
  and the number of addresses restored. The warning that another copy of the
  phrase may be in use is still shown on Receive. A signature-counter
  reconstruction that did not finish is retried after the unlock.
- Some errors on the consolidation screen are shown as the wallet received
  them, in English and with the explorer's address.
- Upgrade safety (#30) is still only partly done: the upgrade test starts
  from the data that 1.0.5 to 1.0.7 stored, and not yet from 1.0.8's.
- Website request handling (#34) is still only partly done: this release
  stops a second Sign press from signing again. Approval time limits, request
  size limits and the other items in that issue are still open.
- After an unlock, a recipient that was only partly typed is not brought back
  with the rest of the send form.
- A payment that combines funds first is kept unencrypted in the extension's
  storage until you leave its success screen or it is cancelled: its
  recipient, its amount, the account's outputs it spends and, until it
  completes, the signed payment, so that the payment can go out while the
  wallet is locked. A copy of the signed payment taken from this browser
  profile's storage stays valid after a cancel, until one of the outputs it
  spends is spent elsewhere; it can only pay that recipient that amount. To
  be sure a cancelled payment cannot go out, send the combined funds (#188).
- While such a payment may still go through after it left the wallet without
  an answer, it cannot be cancelled, and Continue sends the same payment
  again.
- Removing a wallet cancels its payments in progress, with no warning before
  you confirm the removal.
- A lock or a network switch partway through signing one of these
  transactions signs it again in full once more than 16 of its inputs were
  signed: up to 105 extra signatures for a full combining transaction.
- One payment combines at most 11,236 outputs; for more, the send screen
  offers the largest amount one payment can send. A website's request to send
  an amount that needs more than 106 outputs is still refused.

## 1.0.8

### Sending and fees

- Large transactions, such as a consolidation or a sweep, are no longer cut
  off while they upload over a slow connection, which left their outcome
  unknown and their coins set aside. Each send now gets time to upload in
  proportion to its size, and an ordinary payment keeps the time limit it had.
- Speed up no longer runs out of time while it waits for another send to
  finish broadcasting. Its time limit now starts once that send is done.
- The send screen no longer fails with an error when the screen state that an
  earlier version saved lacks fields that an update added. Missing fields are
  filled in when the wallet loads, and saved values are kept.

### Receiving

- Opening Receive shows the selected account's own address and no longer
  switches to another account, which could leave you on an empty account and
  told connected websites that your account had changed.
- An address that has already received funds stays on screen with its Used
  badge and a warning about reusing it. Press New Address for a fresh address,
  which selects the account that owns it. An address that has run out of
  signatures, or that a recovery migration will pay, is never shown or copied:
  Receive says no safe address is available and offers New Address.

### Locking and unlocking

- The wallet now locks when your computer locks, and when the last browser
  window closes. Both are on by default, including for existing wallets, and
  can be turned off in Advanced settings, under Security ("Lock when the
  computer locks" and "Lock when all windows close"). The update adds only
  the idle permission, which Chrome grants without a prompt or a new install
  warning.
- The auto-lock time now counts time the computer was asleep. Your first
  action after the auto-lock time has passed locks the wallet instead of
  keeping it unlocked.
- A lock that comes while an unlock is still under way wins: the wallet stays
  locked and says "The wallet locked while unlocking. Unlock it again."
- A wallet whose stored data includes a wallet type this version does not
  include now unlocks. That wallet is listed as "Unsupported Wallet" and can
  do nothing, and its data is kept unchanged; the other wallets work as usual.

### Websites and approvals

- Websites that embed another site in a frame, such as a swap widget, can now
  use Qbit Wallet inside that frame. The framed site connects, and asks for
  approvals, under its own address, which the approval window names, not the
  address of the page around it. A sandboxed frame gets no wallet connection,
  and the wallet window keeps showing the site in the address bar. Phishing
  protection checks each frame's own site.
- Websites can now tell as soon as Qbit Wallet is ready, from a
  `qbit#initialized` event and an EIP-6963-style announcement, instead of
  checking again and again. These events only help a site find the wallet;
  access still needs your approval.
- While the wallet starts, a website's requests wait until it is ready, so a
  connected website no longer sees your wallet as having no accounts. A
  request lost because the connection to the wallet dropped now fails with
  code 4900, so the website can check whether a transaction went out before
  it tries again, instead of reporting that you rejected the request. Pages
  opened before the update keep the old behaviour until they are reloaded.
- A failed save of a website's permission no longer undoes another change,
  such as disconnecting a site or resetting all sites. A connection reported
  as failed is no longer granted after a restart, and disconnecting a site
  takes effect at once, even while another save is still pending.
- A batch of different PSBTs approved together, from a website's `signPsbts`
  request, now signs every entry, in any order.
  Before, every entry after the first that needed new signatures was refused
  with "P2MR signature budget changed after approval". The approval shows the
  signatures the whole batch needs and how many remain before and after it,
  and a batch that needs more signatures than remain is refused before you
  approve it. If the wallet locks before the batch is signed, the request ends
  and the website has to send it again.
- A website's `signPsbts` request that arrives while another approval is open
  is refused, and the open approval is brought to the front.

### Restoring a wallet and recovery

- A recovery migration now signs every transfer you reviewed in one press.
  Before, a source that needed several transfers signed only the first one
  each time, and showed an error for the rest. If the review is interrupted,
  for example by a lock or because it expired, the wallet says so and asks
  you to review the remaining transfers and sign again.
- When a restore is refused because the signature counts that Testnet4 and
  the local Regtest service report reach the warning threshold together, the
  wallet now shows both counts, where each came from, and what to do. On a
  Testnet4 restore it says to stop the local Regtest service, or turn off
  Local Regtest in Advanced settings, and try again. On a Regtest restore it
  points to the network with the larger share and to the qbit Core recovery
  descriptors. The restore screen shows the latest refusal after each retry.

### Settings and contacts

- Editing a contact no longer clears its alias flag.
- The wallet refuses to save a contact edit that would replace another
  contact with the same address and network, and says "Another contact
  already has this address on this network".

### Repository and release

- Only the Chrome (Manifest V3) extension is built, which is the only one
  that has ever shipped. The unused Manifest V2, Firefox, Brave and Edge
  build targets and the code only they reached are removed. The Chrome
  extension works as before.
- Developers and CI now install with pnpm 11.28.9, pinned by its hash,
  instead of pnpm 8.6.0, which had known advisories. The dependency policy
  now checks every command in the repository's workflows and scripts that
  runs a package manager, and refuses any it cannot fully read. The shipped
  extension code is unchanged.
- Unused dependencies are removed: 25 from the extension and two from the
  keyring service, so the lockfile loses 130 packages and gains none. Unused
  source files, 344 unused translation strings in each language and dead
  constants are removed too. The shipped extension code is unchanged apart
  from the smaller translation files and one unused piece of screen state.
- Every change is now tested against the data that the published 1.0.5, 1.0.6
  and 1.0.7 releases stored, including a browser test that upgrades each of
  them to this version and unlocks it with its accounts, settings, contacts
  and connected websites.

### Known limitations

- Some batches of PSBTs are still refused rather than signed, and none can
  sign more than the signatures you approved:
  - an entry whose signing failed cannot be tried again within its batch;
    send the request again;
  - a batch with repeated PSBTs that needs more than 16 signatures from one
    key, or an entry approved as using signatures the wallet already holds,
    can be refused, depending on the order in which the entries sign;
  - a website's batch approval left open after a wallet reset or a failed
    unlock can no longer sign; reject it and send the request again;
  - a recovery migration's next transfer is refused if anything outside the
    migration signs between its transfers, and preparing a review fails
    while too many signing requests are waiting; review and sign again.
- A restore whose Testnet4 and Regtest signature counts reach the warning
  threshold together is still refused, as in 1.0.7, now with an explanation.
  When most of the count is Testnet4's own, the Testnet4 count that a retry
  restores is close to the threshold and can never be lowered.
- Upgrade safety (#30) is only partly done: this release tests each upgrade
  from the data that 1.0.5 to 1.0.7 stored, and fills in screen state that an
  update adds. Versioned storage formats and migrations are still to come.
- Website request handling (#34) is only partly done: this release adds the
  ready event, holds requests while the wallet starts, and reports lost
  requests as 4900. Approval time limits, double submits, request size limits
  and the other items in that issue are still open.

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
- A broadcast whose rate-limit reply cannot be read in full is no longer
  sent again at once and reported as rate limited. It counts as possibly
  sent: the wallet looks it up and sends the same signed transaction again
  only if the network does not have it. A rate-limit reply saying the
  network already has the transaction counts as sent, and a reply too large
  to read is reported as possibly sent and is not sent again.

### Balance

- The balance no longer stalls while a payment is being broadcast: it briefly
  shows Available and Unavailable as `--`.
- Accounts with more than 500 outputs now see their real Available and
  Unavailable amounts once the wallet has read their outputs.
- On mempool-qbit, accounts whose pending transactions fill whole history
  pages can be read in full again, for sending, restoring, recovery and
  activity history. Recovery sets aside, and names, a source it still cannot
  read instead of stopping, and the balance shows `--` instead of 0 until it
  has been read.

### History

- History shows only the selected account's transactions, as the balance
  does. After Receive moves to a new address, History shows that address's
  transactions. A payment between two of your accounts shows as a send in
  one and a receive in the other.

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
- A pay-to-anchor output in a website's PSBT approval, which lets anyone add
  fee to the transaction, is named "Fee anchor" instead of showing an empty
  recipient, and no longer raises the "Unrecognised output" warning that asked
  you to type CONFIRM. Each PSBT a website sends is refused before approval
  when its pay-to-anchor outputs carry more than 330 bits in total.
- A website PSBT with no outputs, with two inputs that spend the same
  output, or with an input that spends the null outpoint is refused before
  the approval window opens, with an error naming the qbit Core rule it
  breaks.
- Connected websites are saved in a format the wallet controls, and a problem
  loading them no longer keeps the rest of the wallet, including phishing
  protection, from starting. Websites you connected in 1.0.6 stay connected.

### Phishing protection

- Phishing protection diagnostics report protection as degraded while a
  site-access change is still being applied or the block rule is not
  installed.
- Advanced settings show the state of phishing protection, such as fully on,
  starting, degraded, retrying or failed, and the state of its block rule,
  with Retry now unless protection is fully on or not supported.
- When the wallet lets through a page it had stopped for a phishing check,
  and the page cannot be reloaded without sending its form again, Try again
  now opens the page's address afresh instead of showing the same notice
  again.
- A link to a blocked site that opens in a new tab shows the warning there
  without replacing the page you came from, when the wallet's warning rule
  is in place and Chrome gives the wallet access to every denylisted site.
  Otherwise the page you came from shows the warning, as in 1.0.6.
- The warning screen offers Continue only for addresses it can open, and says
  why otherwise.

### Restoring a wallet

- Restoring a wallet can no longer take a signature-counter floor from an
  explorer that claims impossible or extreme address statistics, which could
  have left the wallet unable to sign until it was restored again.
- While you enter a recovery phrase, a word that is not in the word list is
  outlined in red. A complete phrase whose words are all in the list but
  that is still not valid says so.

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
- Editing a contact keeps its place in a list you have reordered.

### Repository and release

- Qbit Wallet now uses Qbit SDK 0.1.1. Keys and addresses are unchanged: the
  wallet's address test vectors pass unchanged across the update.
- A high-severity advisory published during the release, for an HTTP
  redirect package that the packaged extension does not include, is cleared
  by updating the package to its patched release. The packaged extension is
  byte-identical to the build before the change.

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
