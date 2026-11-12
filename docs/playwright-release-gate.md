# Browser Release Gate

The Playwright G3 gate drives the unpacked Chrome MV3 extension in headful
Chromium against a clean qbit regtest backend. It is a release gate: every row
must pass on its first attempt, and a passing retry is still a blocking flaky
result in CI.

## Prerequisites

- Node.js 22 and the repository-pinned pnpm 11.28.9 (`packageManager` in
  `package.json`) through Corepack.
- Docker with `docker compose`.
- The repository-local Playwright Chromium installation.

Do not install global npm packages or add fixed delays to make a row pass.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:e2e:install-browser
corepack pnpm test:e2e:build
```

The extension bundle must exist at `apps/extension/dist/chrome`. Playwright
launches a persistent, isolated browser profile with `--load-extension` and
`--disable-extensions-except`, then discovers the extension from its MV3
service worker. Every spec except `phishing.spec.ts`, `provider-ready.spec.ts`,
`switch-account.spec.ts` and `upgrade.spec.ts` resets the Docker volumes,
starts qbitd and electrs-qbit, funds through qbit Core, and mines
confirmations explicitly. The phishing and provider-ready scenarios need no
regtest node and serve their pages from loopback fixture servers. The
switch-account scenarios need no regtest node either: their wallets live on
Regtest, whose indexer is a loopback stand-in for a chain on which no address
has any activity. Nor does the upgrade scenario: it seeds the profile with the
data that the 1.0.5, 1.0.6 and 1.0.7 releases stored
(`tests/fixtures/release-storage`), and the browser reaches nothing but
loopback. The reset removes only the
volumes of the selected compose project, so set `COMPOSE_PROJECT_NAME` to run
the gate in an isolated project when the default `qbit-wallet-regtest`
project's data must be preserved.

## Commands

Run one scenario from a clean deterministic state:

```sh
corepack pnpm exec playwright test tests/e2e/scenarios/onboard.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/receive.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/send.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/send-draft.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/consolidation.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/send-plan.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/dapp.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/dapp-events.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/approval-hierarchy.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/phishing.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/provider-ready.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/recovery.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/lock.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/biometric-unlock.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/unlock-history.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/switch-account.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/upgrade.spec.ts
```

The consolidation scenario runs one of two plans, which
`QBIT_E2E_CONSOLIDATION_PLAN` chooses: `short` or `full` (see
[Consolidation](#consolidation)). Unset or empty, it is `short` when
`CI=true`, as in the G3 job, and `full` otherwise. Any other value fails the
test before the harness is reset, naming the variable and the accepted
values. The test title names the plan that ran.

```sh
QBIT_E2E_CONSOLIDATION_PLAN=short corepack pnpm exec playwright test tests/e2e/scenarios/consolidation.spec.ts
```

Run the complete local gate after building:

```sh
corepack pnpm exec playwright test
```

Before handoff, run the harness typecheck and the repository build gates:

```sh
corepack pnpm exec tsc --noEmit -p tests/e2e/tsconfig.json
corepack pnpm typecheck
corepack pnpm test:e2e:build
```

CI runs the same command in headful Chromium through `xvfb-run`, with one
worker and one bounded retry. `forbidOnly` and `failOnFlakyTests` are enabled in
CI, so focused tests and retry-only passes fail the job.

## Scenario Matrix

The complete gate is 53 tests (`corepack pnpm exec playwright test --list`).
The results and times below are from the `Playwright G3 scenarios` job in run
40526893310 (PR #327, head `4d7c6741`, 2026-10-27), which ran the 14 tests
then in the gate: all 14 passed on the first attempt with none flaky or
skipped in 9.0 minutes. The 39 tests added since show "Not recorded" until a
recorded run includes them. The line numbers are those of the current specs.
Times are CI timings, not performance budgets. Signing samples are recorded
separately with two-decimal millisecond precision.

| Row                   | Test                                      | Required coverage                                                                                          | Result       | CI time |
| --------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------ | ------: |
| MV3 harness           | `foundation/mv3-harness.spec.ts:4`        | Load the unpacked extension and a clean regtest service worker                                             | Pass         |   4.2 s |
| Onboard               | `scenarios/onboard.spec.ts:5`             | Create, back up, and open a Qbit P2MR wallet on regtest                                                    | Pass         |  14.9 s |
| Receive/fund/rotate   | `scenarios/receive.spec.ts:5`             | Fund issued addresses, rotate safely, mine, and retain previous addresses                                  | Pass         |  26.2 s |
| Send                  | `scenarios/send.spec.ts:23`               | Dust rejection; single/multi-input fees; exact displayed/on-chain fee equality; RBF replacement            | Pass         |  67.7 s |
| Send at relay floor   | `scenarios/send.spec.ts:254`              | Custom 0.25 bits/vB: fee is vsize × 0.25 rounded up, accepted, equal on chain, confirmed; 0.24 blocks Next | Not recorded |       — |
| Draft not saved       | `scenarios/send-draft.spec.ts:142`        | Nothing typed into the send form is saved to storage, before or after a lock                               | Not recorded |       — |
| Draft after restart   | `scenarios/send-draft.spec.ts:171`        | After a restart and a network switch, the form opened by its route is empty, also after a reload           | Not recorded |       — |
| Draft on reload       | `scenarios/send-draft.spec.ts:203`        | Reloading the tab on the send form opens it empty                                                          | Not recorded |       — |
| Draft account switch  | `scenarios/send-draft.spec.ts:220`        | Switching account in the page empties the send form                                                        | Not recorded |       — |
| Draft network switch  | `scenarios/send-draft.spec.ts:233`        | Switching network in the page empties the send form                                                        | Not recorded |       — |
| Draft, other window   | `scenarios/send-draft.spec.ts:247`        | An account switch in another window empties the open form; hiding balances there does not                  | Not recorded |       — |
| Draft, other network  | `scenarios/send-draft.spec.ts:286`        | A network switch in another window empties the open form                                                   | Not recorded |       — |
| Draft across a lock   | `scenarios/send-draft.spec.ts:305`        | The open page keeps the form across Back, Forward and a lock; Send starts a new one                        | Not recorded |       — |
| Consolidation         | `scenarios/consolidation.spec.ts:145`     | Batches at 106 and a smaller size for a refused account; still refused below 500; a send reads its history | Not recorded |       — |
| Send plan             | `scenarios/send-plan.spec.ts:117`         | 214 outputs, MAX, one review: 2 merges, then the payment; reopen mid-signing; exact amount, fee, spends    | Not recorded |       — |
| dApp                  | `scenarios/dapp.spec.ts:37`               | Connect; message sign/verify; PSBT sign; broadcast; revoke                                                 | Pass         |  30.8 s |
| dApp events           | `scenarios/dapp-events.spec.ts:71`        | A site setting, a lock and a revocation reach only the sites they concern                                  | Not recorded |       — |
| Approval hierarchy    | `scenarios/approval-hierarchy.spec.ts:72` | Connect, message, provider Send PSBT at 360x600 in light and dark: warning, payload first, gate            | Pass         |  30.0 s |
| Phishing block        | `scenarios/phishing.spec.ts:265`          | Block a direct navigation to a denylisted host before it reaches the network                               | Pass         |   2.1 s |
| Phishing redirect     | `scenarios/phishing.spec.ts:282`          | Warn on a same-site redirect to a denylisted host; Proceed loads the site                                  | Not recorded |       — |
| Phishing link wrapper | `scenarios/phishing.spec.ts:282`          | Warn on another site's link wrapper to a denylisted host; Proceed loads the site                           | Not recorded |       — |
| Phishing site access  | `scenarios/phishing.spec.ts:318`          | Fall back to the block rule while site access is withheld; warn again once it is granted                   | Not recorded |       — |
| Phishing new tab      | `scenarios/phishing.spec.ts:356`          | Warn in the new tab a link opens, and leave the source tab alone                                           | Not recorded |       — |
| Phishing proceed      | `scenarios/phishing.spec.ts:381`          | Warn on a denylisted link; Proceed lifts only that host, which gets no wallet provider                     | Pass         |   7.4 s |
| Phishing form         | `scenarios/phishing.spec.ts:434`          | A form from another tab reaches a host the user proceeded to once                                          | Not recorded |       — |
| Phishing race         | `scenarios/phishing.spec.ts:462`          | Warn on a link clicked while the service worker runs; the warning page stays (#320)                        | Pass         |   5.8 s |
| Phishing rule status  | `scenarios/phishing.spec.ts:493`          | The wallet pages report the installed block rule                                                           | Not recorded |       — |
| Phishing invalid name | `scenarios/phishing.spec.ts:510`          | No Proceed for a denylisted name outside DNS syntax, and the warning says why                              | Not recorded |       — |
| Phishing rule missing | `scenarios/phishing.spec.ts:525`          | Warn before a denylisted page runs script while the block rule is missing                                  | Not recorded |       — |
| Phishing lookalike    | `scenarios/phishing.spec.ts:575`          | Warn before a `qbit.<tld>` lookalike outside the denylist runs script; Proceed loads it without a provider | Not recorded |       — |
| Phishing back button  | `scenarios/phishing.spec.ts:612`          | Back from the warning for a lookalike opened by its address returns to the page before                     | Not recorded |       — |
| Provider ready        | `scenarios/provider-ready.spec.ts:240`    | A page that listens before the wallet loads hears it is ready, and a late listener can ask                 | Not recorded |       — |
| Provider ready frames | `scenarios/provider-ready.spec.ts:261`    | A frame of another origin gets its own event and announcement; a sandboxed frame gets neither              | Not recorded |       — |
| Wipe/restore          | `scenarios/recovery.spec.ts:88`           | Passphrase separation; exact addresses, balances, floors, and warnings after restore                       | Pass         | 126.0 s |
| Lock                  | `scenarios/lock.spec.ts:25`               | Wrong password, unlock, persisted state, and browser restart                                               | Pass         |  33.4 s |
| Auto-lock             | `scenarios/lock.spec.ts:93`               | Onboarding keepalive stays bounded across an MV3 service-worker restart                                    | Pass         |  56.1 s |
| Window close          | `scenarios/lock.spec.ts:168`              | Closing the last normal window locks the wallet; a wallet popup and a reopened window show the lock screen | Not recorded |       — |
| Lock after onboarding | `scenarios/lock.spec.ts:210`              | The creating page shows the lock screen on a lock and an auto-lock; a page left on Welcome does on a lock  | Not recorded |       — |
| Biometric B1          | `scenarios/biometric-unlock.spec.ts:38`   | Onboarding enrollment, TouchID unlock, and password-change re-wrap                                         | Pass         |  16.8 s |
| Biometric B2          | `scenarios/biometric-unlock.spec.ts:109`  | Settings enrollment with step-up, persistence across restart, and disable                                  | Pass         |  19.8 s |
| Unlock in a tab       | `scenarios/unlock-history.spec.ts:59`     | In a tab opened locked, the unlock leaves Home as the tab's one wallet entry; Back leaves the wallet       | Not recorded |       — |
| Back from Home        | `scenarios/unlock-history.spec.ts:76`     | In a tab opened unlocked, Back from Home leaves the wallet instead of landing on Home again                | Not recorded |       — |
| Unlock after a lock   | `scenarios/unlock-history.spec.ts:88`     | A lock from Settings and an unlock leave Settings, then Home; Back shows Settings, not the unlock screen   | Not recorded |       — |
| Home lock button      | `scenarios/unlock-history.spec.ts:117`    | Home's lock button leaves one unlock entry in Home's place; the unlock puts Home back; Back leaves         | Not recorded |       — |
| Lock on Home          | `scenarios/unlock-history.spec.ts:139`    | A lock from outside the page while Home shows: one unlock entry in Home's place, then Home back            | Not recorded |       — |
| Lock on the send form | `scenarios/unlock-history.spec.ts:159`    | A lock while the send form shows: the unlock shows the form with what was typed; Back gives Home           | Not recorded |       — |
| Switch account        | `scenarios/switch-account.spec.ts:136`    | The card names the wallet; two taps switch wallets; Add account and search                                 | Not recorded |       — |
| Rename wallet         | `scenarios/switch-account.spec.ts:362`    | Rename Wallet, Edit Name and Change Color persist after the popup is reopened                              | Not recorded |       — |
| Remove wallet         | `scenarios/switch-account.spec.ts:432`    | Remove Wallet, new wallets named "Wallet N", and the last wallet kept                                      | Not recorded |       — |
| Read-only wallet      | `scenarios/switch-account.spec.ts:523`    | A read-only wallet shows Read Only and offers no Add Account                                               | Not recorded |       — |
| Upgrade from 1.0.5    | `scenarios/upgrade.spec.ts:165`           | 1.0.5's stored data unlocks with its accounts, settings, contacts, sites and saved UI state                | Not recorded |       — |
| Upgrade from 1.0.6    | `scenarios/upgrade.spec.ts:165`           | 1.0.6's stored data unlocks with its accounts, settings, contacts, sites and saved UI state                | Not recorded |       — |
| Upgrade from 1.0.7    | `scenarios/upgrade.spec.ts:165`           | 1.0.7's stored data unlocks with its accounts, settings, contacts, sites and saved UI state                | Not recorded |       — |

The dApp PSBT-signing and wipe/restore rows were previously blocked (a
`-32603: Not supported` provider rejection and a restore scan that never
reached the recovery report). Both pass now, and no product blocker is open.
The wipe/restore row keeps its explicit ten-minute report bound inside a
fifteen-minute scenario timeout; do not raise either without measured product
evidence.

The send-plan row signs 216 signatures in the browser, so it sets its own
twelve-minute timeout. Three consecutive local runs on 2026-11-12, headful
under Xvfb against the pinned images, passed on the first attempt in 243,
207 and 212 seconds, 11.4 minutes for the three with their regtest resets.
Funding the 214 outputs in one transaction took 9-11 seconds; signing, from
the confirmation to the signed payment, 174-204 seconds (0.81-0.94 seconds
a signature); and the payment reached the mempool 10-14 seconds after the
block that confirmed the merges. The gate's runners sign at about 1.25
seconds a signature, so the row should take about 6 minutes there. It sets
the longest auto-lock first: the default 3 minutes falls due about when
signing ends, and the lock that follows takes the progress screen to the
unlock screen at a point that depends on the runner's pace.

### Consolidation

The consolidation row mines one coinbase output per block to the account, as
a miner's payout address receives them, and matures them all. It turns the
wallet's lock on computer lock off: under `xvfb-run`, Xvfb's screen saver
starts ten minutes after the server last reset, since Playwright's input is
no X input, and Chrome then reports the computer locked. The two plans:

| Plan    | Funded outputs | Batches, in order      | Inputs consolidated | Confirmed outputs after |
| ------- | -------------: | ---------------------- | ------------------: | ----------------------: |
| `short` |            610 | 106, then 9            |                 115 |                     497 |
| `full`  |            940 | 106, 106, 106, 106, 30 |                 454 |                     491 |

Past 500 outputs the regtest explorer answers `/address/:address/utxo` with
HTTP 400 and `Too many unspent transaction outputs (>500). Contact support to
raise limits.`, while `/address/:address` still counts every output. The row
asserts that answer over HTTP before the wallet reads it, so a change in the
explorer's refusal fails here and not as a missing button. The send screen
must then offer Consolidate, and the consolidation screen must state the
count and the limit, refuse batch sizes 1 and 107, and preview the fee of a
full batch.

Each batch is prepared, reviewed, signed and broadcast through the screens,
the first at 106 and the last at the plan's smaller size, whose fee preview
and cost note the row checks. On chain, each batch must spend exactly the
inputs its summary names, all the account's and none spent before, into one
output back to the account, for the fee the screens showed. After every
batch, "Consolidate next batch" must open the screen again at the size just
sent, with the batch pending. Each batch is mined before the next is
prepared, so the screen's count must then drop by n - 1 for a batch of n
inputs. The explorer lets each reply be reused for 10 s, and the row changes
the chain faster than a person could, so after the funding, after each batch
reaches the explorer's mempool and after each block it drops the browser's
HTTP cache: the wallet's next read must show the new state at once, in one
read.

Both plans end at or under 500 confirmed outputs, and the explorer still
refuses the listing with the same answer: electrs never lists an address
again once it passed its limit (see
[Explorer UTXO listing limit](explorer-utxo-limit.md)). The row ends there:
the wallet must still offer Consolidate, show the new count and build a
batch, which it leaves unsigned, and a send to another address, its outputs
read from the account's history, must pay the recipient and the fee it
showed.

## Failure Evidence

Playwright writes the HTML report to `playwright-report` and per-test evidence
to `test-results/playwright`. CI uploads both directories for 14 days, excluding
the ephemeral Chromium profile. A failed row contains:

- `test-failed-*.png`, `trace.zip`, and retained video;
- `page-console.log` and `extension-service-worker.log` attachments;
- `network-requests.json` and the strict `network-audit.json` attachment;
- `regtest-state.json` with chain, height, mempool, and tracked state;
- `failing-identifiers.json` with the extension, account, and transaction IDs;
- `pqc-sign-durations.json` for the row.

The phishing, provider-ready, switch-account and upgrade rows use their own
fixtures and run without regtest, so the regtest, network-audit and PQC
attachments above do not apply to them; a failed row of any of them attaches
the extension service-worker log. A failed switch-account row also attaches
`empty-regtest-explorer.log`.

The approval-hierarchy row also attaches `connect-approval-<theme>.png`,
`message-approval-<theme>.png`, and `psbt-approval-<theme>.png` at 360x600 for
`light` and `dark` on every run, so the compact warning and payload-first
order can be reviewed without reproducing the scenario.
Its PSBT step is a `window.qbit.sendQbit` request, so the production Send
action is what is asserted: the title and the requested destination and amount
rows must be fully inside the first 360x600 viewport. The row rejects that
request and then asserts the regtest mempool is still empty.

The send-plan row attaches `send-plan-<screen>.png` at the popup's 357x600 on
every run: the send screen's card, the review, signing, the home screen's
card, waiting for the merges and the success screen. Each is taken after
asserting that the screen's key content is whole in that first viewport,
except the send screen's Next, which follows the form's other fields below
the fold at that size, as for any send. The row also attaches
`send-plan-timings.json` with its funding, signing and payment times.

The run-level PQC canary is
`test-results/playwright/pqc-sign-durations.jsonl`. Samples from the run above
were 4,463.36 ms for a one-input send, 6,977.43 ms for a three-input send,
6,442.15 ms for its three-input RBF bump, and 1,590.42 ms for a P2MR dApp
message signature. In passing gate runs from 2026-10-23 to 2026-10-27,
before and after the SDK moved to npm, they ranged over 3.9-5.1 s, 5.4-7.6 s,
5.4-7.3 s and 0.8-1.6 s. Treat large movement as a regression signal, not as
a fixed cross-machine threshold. The send-plan row adds one
`wallet-send-plan-sign` sample of 216 inputs, from the confirmation to the
signed payment: 174,477.62-203,590.26 ms in the local runs above, not yet
recorded in CI.

The network audit allows only configured Qbit chain/explorer URL prefixes. A
dApp fixture may add only its own loopback HTTP origin. Add intentional chain
endpoints with `QBIT_E2E_ALLOWED_NETWORK_ENDPOINTS` as a comma-separated list;
never add a broad hostname exception just to clear a failure.

## Retry, Flake, and Quarantine Policy

- Local runs have no retries. CI has exactly one retry to collect a second set
  of evidence, and `failOnFlakyTests` keeps any retry-pass blocking.
- Reproduce a failure against a fresh regtest reset before classifying it. Use
  traces, network/service-worker logs, regtest state, and tracked identifiers to
  distinguish product defects from harness defects.
- Fix synchronization with observable UI, provider, transaction, or backend
  conditions. Arbitrary sleeps, broader network exceptions, weakened equality
  assertions, and increased retry counts are prohibited.
- Quarantine requires a dedicated PR, a linked issue, a named owner, a removal
  condition, and an expiry no later than seven days. The quarantined row must
  continue running in a visible non-blocking job; it may not be silently
  skipped or excluded from reports.
- No quarantine is active. A quarantined release-critical row means the G3
  release gate is incomplete and cannot authorize a release.
