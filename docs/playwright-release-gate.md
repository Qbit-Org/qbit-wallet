# Browser Release Gate

The Playwright G3 gate drives the unpacked Chrome MV3 extension in headful
Chromium against a clean qbit regtest backend. It is a release gate: every row
must pass on its first attempt, and a passing retry is still a blocking flaky
result in CI.

## Prerequisites

- Node.js 22 and the repository-pinned pnpm 8.6.0 through Corepack.
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
service worker. Every spec except `phishing.spec.ts` resets the Docker
volumes, starts qbitd and electrs-qbit, funds through qbit Core, and mines
confirmations explicitly. The phishing scenarios need no regtest node and
serve their pages from a loopback fixture server. The reset removes only the
volumes of the selected compose project, so set `COMPOSE_PROJECT_NAME` to run
the gate in an isolated project when the default `qbit-wallet-regtest`
project's data must be preserved.

## Commands

Run one scenario from a clean deterministic state:

```sh
corepack pnpm exec playwright test tests/e2e/scenarios/onboard.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/receive.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/send.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/dapp.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/approval-hierarchy.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/phishing.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/recovery.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/lock.spec.ts
corepack pnpm exec playwright test tests/e2e/scenarios/biometric-unlock.spec.ts
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

The complete gate is 14 tests. The results and times below are from the
`Playwright G3 scenarios` job in run 40526893310 (PR #327, head `4d7c6741`,
2026-10-27), where all 14 passed on the first attempt with none flaky or
skipped in 9.0 minutes. Times are CI timings, not performance budgets.
Signing samples are recorded separately with two-decimal millisecond
precision.

| Row                 | Test                                                       | Required coverage                                                                               | Result | CI time |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ | ------: |
| MV3 harness         | `foundation/mv3-harness.spec.ts:4`                         | Load the unpacked extension and a clean regtest service worker                                  | Pass   |   4.2 s |
| Onboard             | `scenarios/onboard.spec.ts:5`                              | Create, back up, and open a Qbit P2MR wallet on regtest                                         | Pass   |  14.9 s |
| Receive/fund/rotate | `scenarios/receive.spec.ts:5`                              | Fund issued addresses, rotate safely, mine, and retain previous addresses                       | Pass   |  26.2 s |
| Send                | `scenarios/send.spec.ts:23`                                | Dust rejection; single/multi-input fees; exact displayed/on-chain fee equality; RBF replacement | Pass   |  67.7 s |
| dApp                | `scenarios/dapp.spec.ts:37`                                | Connect; message sign/verify; PSBT sign; broadcast; revoke                                      | Pass   |  30.8 s |
| Approval hierarchy  | `scenarios/approval-hierarchy.spec.ts:72`                  | Connect, message, provider Send PSBT at 360x600 in light and dark: warning, payload first, gate | Pass   |  30.0 s |
| Phishing block      | `scenarios/phishing.spec.ts:161`                           | Block a direct navigation to a denylisted host before it reaches the network                    | Pass   |   2.1 s |
| Phishing proceed    | `scenarios/phishing.spec.ts:178`                           | Warn on a denylisted link; Proceed lifts only that host, which gets no wallet provider          | Pass   |   7.4 s |
| Phishing race       | `scenarios/phishing.spec.ts:232`                           | Warn on a link clicked while the service worker runs; the warning page stays (#320)             | Pass   |   5.8 s |
| Wipe/restore        | `scenarios/recovery.spec.ts:86`                            | Passphrase separation; exact addresses, balances, floors, and warnings after restore            | Pass   | 126.0 s |
| Lock                | `scenarios/lock.spec.ts:24`                                | Wrong password, unlock, persisted state, and browser restart                                    | Pass   |  33.4 s |
| Auto-lock           | `scenarios/lock.spec.ts:88`                                | Onboarding keepalive stays bounded across an MV3 service-worker restart                         | Pass   |  56.1 s |
| Biometric B1        | `scenarios/biometric-unlock.spec.ts:38`                    | Onboarding enrollment, TouchID unlock, and password-change re-wrap                              | Pass   |  16.8 s |
| Biometric B2        | `scenarios/biometric-unlock.spec.ts:109`                   | Settings enrollment with step-up, persistence across restart, and disable                       | Pass   |  19.8 s |

The dApp PSBT-signing and wipe/restore rows were previously blocked (a
`-32603: Not supported` provider rejection and a restore scan that never
reached the recovery report). Both pass now, and no product blocker is open.
The wipe/restore row keeps its explicit ten-minute report bound inside a
fifteen-minute scenario timeout; do not raise either without measured product
evidence.

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

The phishing rows use their own fixtures and run without regtest, so the
regtest, network-audit and PQC attachments above do not apply to them; a
failed phishing row attaches the extension service-worker log.

The approval-hierarchy row also attaches `connect-approval-<theme>.png`,
`message-approval-<theme>.png`, and `psbt-approval-<theme>.png` at 360x600 for
`light` and `dark` on every run, so the compact warning and payload-first
order can be reviewed without reproducing the scenario.
Its PSBT step is a `window.qbit.sendQbit` request, so the production Send
action is what is asserted: the title and the requested destination and amount
rows must be fully inside the first 360x600 viewport. The row rejects that
request and then asserts the regtest mempool is still empty.

The run-level PQC canary is
`test-results/playwright/pqc-sign-durations.jsonl`. Samples from the run above
were 4,463.36 ms for a one-input send, 6,977.43 ms for a three-input send,
6,442.15 ms for its three-input RBF bump, and 1,590.42 ms for a P2MR dApp
message signature. In passing gate runs from 2026-10-23 to 2026-10-27,
before and after the SDK moved to npm, they ranged over 3.9-5.1 s, 5.4-7.6 s,
5.4-7.3 s and 0.8-1.6 s. Treat large movement as a regression signal, not as
a fixed cross-machine threshold.

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
