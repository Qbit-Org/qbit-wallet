# Tree Pass Marker

A pull request's checks belong to its head commit, so GitHub runs every
workflow again whenever that commit changes, even when the tree does not.
That happens on every landing here: a maintainer rewrites the branch as one
signed commit with exactly the same tree, and CI runs again. The tree pass
marker lets that second run skip the expensive jobs when the tree under test
already passed them in an earlier run that GitHub confirms, while every
required check still reports success on the new commit.

That was the marker's purpose for G3 too: the signed landing commit could
skip G3 after the unsigned head had passed it. It no longer applies there.
On a pull request whose head commit is not signed, G3
[waits for a signed head](playwright-release-gate.md#signed-heads): no shard
runs and nothing is saved, so the first signed head of a tree runs G3 in
full, unless it changes only documentation. For G3 the marker still helps
when a head that passed is signed again with the same tree, or a later run,
after a close and reopen say, tests a tree that already passed.
`Typecheck, test, and build` runs on every head, signed or not, so there the
landing commit still skips after the unsigned head passed.

The logic is in
[`scripts/security/tree-pass-marker.mjs`](../scripts/security/tree-pass-marker.mjs),
with its tests next to it. The workflows only wire it together.

## What it covers

| Workflow                      | Jobs the marker covers                                                                                                                                                                                      | On a marker hit                                                                                                               | Never covered       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `ci.yml`                      | `Typecheck, test, and build` and its lanes `Unit tests: qbit-extension`, `Unit tests: wallet-background`, `Typecheck, security checks and other unit tests` and `Build and reproduce the extension`; `Lint` | each lane runs and skips its steps; `Typecheck, test, and build` runs, checks the lanes and skips the rest; `Lint` is skipped | `Dependency policy` |
| `playwright-release-gate.yml` | `Playwright G3 scenarios`, `Playwright G3 shard 1 of 5` … `Playwright G3 shard 5 of 5`                                                                                                                      | each shard runs and skips its steps; `Playwright G3 scenarios` runs, checks the shards and skips the rest                     | none                |

`Dependency policy` always runs: its `pnpm audit` asks the registry for current
advisories and its risk exceptions expire by date, so the same tree can pass
one day and fail the next. It takes about a minute. `release.yml`,
`build-regtest-images.yml`, `pqc.yml` and `qbit-conformance.yml` do not use the
marker.

A pull request that changes only documentation that no skipped step reads
skips the steps of three of the four lanes, the G3 shards and each required
job's last step, without a marker, and saves none. `Lint` still runs, and so
does the lane `verify-workspace`, whose security tooling tests read every
tracked file. See
[Docs-only changes](ci-docs-only.md). `Tree pass marker` decides that too, in
its last step.

A skip carries an earlier result forward; it does not show that the tree
would pass again today. The covered jobs are not all a function of the tree
alone:

- Each G3 shard builds the qbitd regtest image from
  `docker/regtest/qbitd-release.Dockerfile`, which starts from the unpinned
  `debian:bookworm-slim` image and runs `apt-get update` and `apt-get install`,
  and it runs `playwright install --with-deps chromium`, which downloads a
  browser build and installs system packages. The qbitd release archive and the
  electrs-qbit image are pinned by digest.
- Every covered job runs on a runner image that changes over time and installs
  from the registry, although `pnpm install --frozen-lockfile` checks each
  package against the lockfile's integrity hash.

So a change in Debian, Playwright's browser builds or the runner image that
would break a covered job shows up on the next run that does not skip, not
on a commit whose tree already passed. Use `ci:full-run` (below) to check a
tree against today's inputs.

A skipped run also produces none of the covered jobs' artifacts: no
`chrome-mv3-extension` build (from `Build and reproduce the extension`) and no
Playwright reports for the commit that lands. They are in the passing run that the gate step's summary links to,
which keeps them for 14 days. If a release or the reproducible-build check
(docs/reproducible-builds.md) needs that run's URL or artifacts, take them
from there, or force a full run.

## How a run decides

Each covered workflow has two extra jobs, `Tree pass marker` first and
`Record tree pass` last. `Tree pass marker` runs only for `pull_request`
events; on every other event it is skipped, and the covered jobs run in full
without waiting for it.

1. **Key.** `Tree pass marker` computes the key prefix
   `tree-pass-v1-<workflow>-salt<workflow salt>.<repository salt>-<tree>-pr<number>-`.
   `<tree>` is the tree of `GITHUB_SHA`, the commit the workflow tests: GitHub's
   merge of the head into the base (`refs/pull/<number>/merge`), so a different
   head tree or a moved base gives a different key. The key never names a
   commit, so a re-signed commit with the same tree gets the same key. A
   marker's full key adds the run that saved it: `<prefix><run ID>-<attempt>`.
2. **Eligibility.** Markers are used only when the event is `pull_request`, the
   pull request's head branch is in this repository (its repository ID equals
   `GITHUB_REPOSITORY_ID`), and the pull request does not carry the
   `ci:full-run` label. The labels are read from the API when the
   job runs, not from the event, so a label added later counts when the run is
   re-run. If they cannot be read, the run is treated as forced. A run that is
   not eligible never computes the key, so a bad salt cannot fail it.
3. **Lookup.** An eligible run looks the prefix up with `actions/cache/restore`
   in lookup-only mode, as both its key and its `restore-keys`. The newest
   entry whose key starts with the prefix matches, and the step reports its
   full key as `cache-matched-key`. **The marker is never restored.** The cache
   action extracts an entry with `tar -xf <archive> -P -C <workspace>`, which
   honours absolute and `../` paths, and a cache entry is exactly what the
   checks below distrust: someone who can push to the pull request could save
   an entry that overwrites `tree-pass-marker.mjs`, or a file Node loads, before
   the decision runs. Only the matched key is read, and only as data.
4. **Decision.** The run skips only when all of these hold:

   - the lookup step succeeded and matched a key that is exactly the prefix
     followed by `<run ID>-<attempt>`, both plain numbers;
   - that run is not this run (a re-run of the run that saved the marker runs
     in full);
   - GitHub's record of that run (`GET /repos/{repo}/actions/runs/{id}`) shows
     this repository, this workflow's path, event `pull_request`, this pull
     request's head repository and head branch, a head commit whose tree is
     the tree of this run's head commit, and a latest attempt equal to the
     attempt in the key, so a later attempt, such as a re-run with
     `ci:full-run` that failed, invalidates it, even if that attempt passed
     too. The record does not show which pull request the run belonged to,
     the base it merged with, or the workflow file it ran, which a
     `pull_request` run takes from that merge. The rules after the artifact
     check bind the run to this pull request and refuse any recorded base
     change; nothing binds the base commit (see "What remains possible");
   - the jobs of that attempt (`GET …/runs/{id}/attempts/{n}/jobs`) show every
     covered job and `Record tree pass` completed with `success`, once each,
     by name; each leg of the G3 shard matrix is its own job there, named
     `Playwright G3 shard <n> of 5`, so every shard is checked, not only
     `Playwright G3 scenarios`, and so is each lane of
     `Typecheck, test, and build`. A run that tested nothing, or that a marker
     skipped, fails this, because `Record tree pass` and `Lint` report skipped
     there. With the check above, this is the rule **both attempts**: the
     covered jobs and the save job are green in the attempt that saved the
     marker, which must also be the run's latest attempt;
   - that run holds exactly one unexpired artifact named
     `tree-pass-<SHA-256 of the full key>`
     (`GET …/runs/{id}/artifacts?name=…`). Only a job of that run can upload an
     artifact to it, and in a run of this workflow as reviewed only
     `Record tree pass` does, after its own checks. So an entry planted under a
     key that names some other run of this workflow has no artifact to match.
     A run of a changed workflow can upload any artifact it likes, which is
     why the rules below exist.

   The run must also belong to this pull request, against an unchanged base,
   with nothing failing since. Each of these rules refuses under its own name
   in the decision's log line and summary (`Running every job: [<rule>] …`),
   naming the run or event it found; a listing a rule needed that could not be
   read carries the rule's name too:

   - **one pull request per head branch**: GitHub lists exactly one pull
     request ever opened from this head branch, open, closed or merged, and
     it is this one
     (`GET /repos/{repo}/pulls?head=<owner>:<branch>&state=all&per_page=2`,
     with the branch name encoded; any count other than one refuses). A
     branch deleted and created again still lists the closed pull requests
     from it. So the run can only belong to this pull request, not to another
     one from the same branch into a base someone else chose;
   - **run after the pull request**: the run's `created_at`, which stays its
     first creation through every re-run, is strictly after this pull
     request's `created_at` from the same listing. A run created before the
     pull request was opened, or in the same second, cannot be its run;
   - **base unchanged**: neither this pull request's timeline
     (`GET /repos/{repo}/issues/{n}/timeline`) nor its issue events
     (`GET /repos/{repo}/issues/{n}/events`) hold an event whose name starts
     with `base_ref_` or `automatic_base_change_`. The ones seen here are
     `base_ref_changed` (retargeted by hand), `automatic_base_change_succeeded`
     (retargeted by GitHub after the base branch was merged and deleted),
     `base_ref_force_pushed` and `base_ref_deleted`;
     `automatic_base_change_failed` is GitHub's name for a retarget it could
     not make. GitHub's REST reference lists `base_ref_changed` and
     `automatic_base_change_*` as issue events and says the timeline does not
     return them, though it does, and it does not list `base_ref_force_pushed`
     or `base_ref_deleted`. So both listings are read, and the check goes by
     prefix: any event named for the base turns skipping off;
   - **head branch kept**: neither listing holds `head_ref_deleted` or
     `head_ref_restored`. If this pull request's head branch was deleted
     while it was open, and perhaps created again, a run of another pull
     request from that branch created after this one may have the head this
     one has now. `head_ref_force_pushed` is routine and does not count;
   - **no later failure**: this is the first attempt of this run, since a
     re-run's earlier attempts ran this tree after the run the marker names
     and are not read; and GitHub's listing of this workflow's `pull_request`
     runs on this head branch
     (`GET /repos/{repo}/actions/workflows/<file>/runs?event=pull_request&branch=<branch>`)
     holds no run whose head commit has this head's tree, other than this run
     and the one the marker names, that is still going, nor one that ended
     any way but `success` (failed, cancelled, timed out, skipped and the
     rest) and whose `created_at` or `run_started_at` (the start of its latest
     attempt, which a re-run moves) is at or after the `created_at` of the run
     the marker names. A later failure wins over an earlier pass. Each run
     counts by its latest attempt, the only one the listing shows: a later
     run whose first attempt failed and whose re-run passed counts as a pass.
     Reading every attempt of every run of the tree would take a request per
     run, so the earlier attempts are not read. The run the marker names must
     be in the listing too, for this head tree, still at the attempt the
     marker names: its record was read at the start of the decision, and a
     re-run of it started since shows here at a later attempt, which refuses
     whatever that attempt shows. That run is judged by its jobs (both
     attempts) and by its attempt, not by its overall result, which is not
     read here or anywhere else: `Record tree pass` needs every covered job,
     so a green save job in the latest attempt means the covered jobs passed,
     and the one job outside them, `Dependency policy`, runs again in the run
     that skips. A red or unfinished overall result there would only stop
     skips while `Dependency policy` is red for reasons outside the tree, and
     make the landing push wait for a whole run.

   The timeline, the issue events and the run listing are each read page by
   page to the end. A failed page, a page that is not a list, a short page
   that names a next page, 3,000 or more events in either event listing, and
   1,000 or more runs (ten full pages) count as unreadable. The run listing must
   also report the same `total_count` on every page and hold exactly that many
   runs: GitHub stops a filtered run listing at 1,000 while the count goes on,
   and a run added while the pages are read moves the count. Every listed entry
   must have the fields the rule reads, with the right types; a run without an
   ID, a readable head tree, or, for a run that did not succeed, readable times,
   and an event without a name, all refuse. Each request has 15 seconds, and all
   requests of one decision share four minutes; a request that the deadline cuts
   short, or that it leaves unsent, is a failed request. GraphQL's typed
   `timelineItems(itemTypes: …)` was not used: its `totalCount` counts every
   timeline item whatever the types asked for (32 on qbit-wallet #137, which has
   three base events). A miss, an expired or evicted entry, a cache service
   error, a timeout, any other key, any check that fails and any API error all
   mean "run everything". `Tree pass marker` needs `actions: read` for the run,
   jobs, artifact and the listing of runs, and `pull-requests: read` for the
   labels, the pull request listing, the timeline and the issue events (GitHub
   accepts either Issues or Pull requests read for the last two).

5. **Covered jobs.** A required job always runs. Its first step checks the
   decision, and every other step is skipped only when `Tree pass marker`
   succeeded and said "skip", or said that the change is docs-only
   ([Docs-only changes](ci-docs-only.md)), which `verify-workspace` ignores.
   On a marker hit, that step's summary names the passing run
   (`…/actions/runs/<id>/attempts/<n>`), so a skipped run still leaves the URL
   of the run that tested the tree. If `Tree pass marker` fails or is
   skipped, every step runs. A covered job that is not required, `Lint`, is
   skipped whole on a marker hit, and runs on a docs-only change.

   The browser release gate runs its suite in five shards (see
   [Sharded G3 scenarios](#sharded-g3-scenarios)). Each shard is a leg of a
   matrix job and is gated like a required job: it runs unless the run is
   cancelled, and only the gate skips its steps. `Playwright G3 scenarios`,
   the required check, needs them all and runs in every case, a cancelled
   run included: it runs its gate and then checks the shards, a marker hit
   included.

   `Typecheck, test, and build` works the same way over four lanes, each a
   job of its own (see
   [Lanes of Typecheck, test, and build](#lanes-of-typecheck-test-and-build)).

6. **Save.** `Record tree pass` runs only when the decision asked for a save,
   which happens only for an eligible run that did not skip, and the change is
   not docs-only. It needs every covered job, each lane of
   `Typecheck, test, and build` included, except the G3 shards, which reach it
   through `Playwright G3 scenarios`. GitHub's implicit `success()` also
   requires every job it needs to have succeeded. Its record step then checks
   again: every job it needs must report `success` and the output
   `tested=true`, which only its last step sets after all its steps ran; for `Playwright G3 scenarios`
   that means every shard passed and set its own `tested-<n>` (see
   [Sharded G3 scenarios](#sharded-g3-scenarios)). A failure there means the
   wiring is wrong, and the step fails. Then, with a warning and no marker but
   without failing the run, it declines when:

   - the key recomputed from the checked-out commit and both salts differs
     (a salt changed during the run);
   - the pull request now carries `ci:full-run`, or its labels cannot be read.
     This matters for "Re-run failed jobs", which reuses the first attempt's
     decision.

   Otherwise it writes a small JSON file naming the full key, the run ID and
   the attempt, uploads it as the artifact, and only after the upload succeeds
   saves it in the cache under the full key. Each run saves under its own key,
   so a later full pass of the same tree adds a newer marker.

A run the marker skipped never saves, because its decision says "no save" and
its covered jobs never report `tested=true`. A docs-only run never saves
either: `Record tree pass` does not run, and its covered jobs never report
`tested=true`.

### Lanes of `Typecheck, test, and build`

`ci.yml` runs the work of `Typecheck, test, and build` in four lanes at once,
each on its own `blacksmith-2vcpu-ubuntu-2404` runner:

| Lane (job ID)                                                          | What it runs after checkout, install and the two prepare steps                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Unit tests: qbit-extension` (`verify-extension-tests`)                | `pnpm --filter qbit-extension run test`: its `node --test ./scripts/*.test.js`, then its vitest suite                                                                                                                 |
| `Unit tests: wallet-background` (`verify-wallet-background-tests`)     | `pnpm --filter @qbit/wallet-background run test`                                                                                                                                                                      |
| `Typecheck, security checks and other unit tests` (`verify-workspace`) | `release:readiness -- --report-only` (before the prepare steps), `test:security-tooling` and `sdk:packages:check`, `typecheck`, every other workspace package's tests, `test:pqc-golden` and `test:protocol-vectors`  |
| `Build and reproduce the extension` (`verify-package`)                 | `build:repro:extension -- --skip-prepare`, which builds the Chrome MV3 package twice from a clean state and fails unless the two builds are byte-identical, and the `chrome-mv3-extension` upload of the second build |

The two prepare steps, "Prepare workspace declarations" and "Build wallet
background package", build the packages' `lib/`, which the tests, the
typecheck and the extension build read, so every lane runs them. The third
lane picks its packages with exclusion filters only
(`--filter '!qbit-extension' --filter '!@qbit/wallet-background'`), so a new
workspace package's tests run there without a workflow change. No lane needs
another lane's output or the order in which `pnpm -r` runs packages.

- **Each lane** needs `Tree pass marker` with `if: ${{ !cancelled() }}`, has
  the gate, and sets `tested=true` in its last step. It has 30 minutes, about
  four times the longest lane's measured time. The lanes are separate jobs,
  not legs of a matrix: they run different steps, and each reports its own
  result, so `Typecheck, test, and build` can name the lane that failed and
  how, and each lane sets the plain `tested` that `Record tree pass` reads.
- **`Typecheck, test, and build`** (job `verify`) is the required check. It
  is not a matrix job, needs `Tree pass marker` and the four lanes with
  `if: ${{ always() }}`, runs on Blacksmith like the lanes, and has
  `permissions: {}`: it reads only `needs`. After the same gate, its check
  step requires each lane's result to be `success` on every run, a marker hit
  included. Unless the gate said "skip", it also requires each lane's
  `tested` to be `true`. Otherwise it fails, and an error annotation and a
  line of its step summary name each lane that failed and why. Its last step,
  gated as usual, sets `tested=true`. On a marker hit its gate's summary says
  the lanes skipped their steps; on a docs-only change, that every lane but
  `verify-workspace` did.
- **`Record tree pass`** needs `Lint`, each lane and
  `Typecheck, test, and build`, and its record step checks each one's
  `tested`; `decide` checks each lane by name in the run a marker names.

`Typecheck, test, and build` ends as `Playwright G3 scenarios` does in the
tables under [Sharded G3 scenarios](#sharded-g3-scenarios), with lanes in
place of shards, and the same holds for a cancelled run, a lane that hits its
timeout and "Re-run failed jobs". One difference: each lane reports its own
result, so a lane that was skipped fails the check on a marker hit too. The
wiring tests check every one of those cases for the lanes.

Measured on the 2-vCPU runner in run 44101553297, before the split, the work
that moved into the lanes took about 186 s (`qbit-extension` tests), 203 s
(`wallet-background` tests), 313 s (readiness, the adversarial suite at about
88 s, typecheck, about 206 s of other packages' tests, and the PQC and
protocol vectors) and 307 s (a package build at about 112 s, two more clean
builds at about 193 s, and the upload), plus about 26 s of prepare steps in
each lane. Since then `verify-workspace` runs the security tooling tests and
the SDK pin check in place of the adversarial suite (whose test files run in
their packages' lanes), and `verify-package` builds twice, in its
reproducibility step alone, in place of three times. With about a minute of
setup per lane, the longest lane takes about 5 to 5.5 minutes, and the
required check reports a few seconds after it, where the single job took 14
to 22 minutes. A full run takes about 4 to 5 runner-minutes more than the single
job did: three more setups and prepare steps, and a few seconds for
`Typecheck, test, and build`. On a marker hit, all four lanes still start,
each only to run its gate; on a docs-only change, three do, and
`verify-workspace` runs in full.

### Sharded G3 scenarios

`playwright-release-gate.yml` splits the Playwright suite across five runners
that run in parallel, with `playwright.config.ts` unchanged:

- **`Playwright G3 shard <n> of 5`** (job `playwright-g3-shard`) is a matrix
  job over `shard: [1, 2, 3, 4, 5]` with `fail-fast: false`. Each leg builds the
  extension, starts its own regtest harness and runs
  `playwright test --shard=<n>/5`, which takes whole files, in file order, by
  test count, so every test runs in exactly one shard. It needs
  `Tree pass marker` with
  `if: ${{ !cancelled() && !(needs.tree-pass.result == 'success' && needs.tree-pass.outputs.signed-head-wait == 'true') }}`,
  so a cancelled run stops it and a run that waits for a signed head skips
  the whole matrix, has the gate, and uploads its report as
  `playwright-release-gate-<run ID>-<attempt>-shard-<n>`. It has 45 minutes:
  the longest shard takes about 12.5 with its setup, and the longest test
  timeout, the wipe/restore scenario's 15 minutes, reached on the first try
  and again on the retry, still ends inside it. Its
  last step sets the output `tested-<n>`: the legs of a matrix job share one
  set of outputs, and an output that two legs set holds whichever finished
  last, so one `tested` would let one shard's pass stand for another's.
  GitHub does not record an empty output, so a leg leaves the others' alone.
- **`Playwright G3 scenarios`** (job `playwright-release-gate`) is the
  required check. It is not a matrix job, needs `Tree pass marker` and the
  shards with `if: ${{ always() }}`, runs on Blacksmith like the shards, and
  has `permissions: {}`: it reads only `needs`, with no checkout and no
  token. After the same gate, its check step requires the
  shards' combined result to be `success` on every run, a marker hit
  included. Unless the gate said "skip", it also requires `tested-1` to
  `tested-5` to be `true`. Otherwise it fails and names the shard. Its last
  step, gated as usual, sets `tested=true`. Its name is computed: while the
  run waits for a signed head it is
  `Playwright G3 scenarios (waits for a signed head)`, its gate sets `wait`
  instead of `skip`, its check step requires the shards' result to be
  `skipped` with no `tested-<n>` set, and its last step does not run (see
  [Signed heads](playwright-release-gate.md#signed-heads)).
- **`Record tree pass`** needs `Tree pass marker` and
  `Playwright G3 scenarios`, not the shard matrix: its record step reads one
  `tested` per job it needs, which a matrix job cannot give per leg. It
  reaches the shards through `Playwright G3 scenarios`, whose `tested=true`
  stands for all five, and `decide` checks each leg by name in the run a
  marker names. It does not run while the run waits for a signed head.

The matrix is the one source of the shard list and total. The wiring tests
fail unless it is exactly `1` to `n`, and the total in `--shard`, the job
name, the outputs, the check step's list and `TREE_PASS_COVERED_JOBS` all use
the same `n`. They also run each leg's command line through a stand-in
`xvfb-run`, which must see `--shard=1/5` to `--shard=5/5`, each once.

How `Playwright G3 scenarios` ends:

| `Tree pass marker`           | Every shard passed            | A shard failed | A shard was cancelled or timed out | The shard job was skipped |
| ---------------------------- | ----------------------------- | -------------- | ---------------------------------- | ------------------------- |
| skipped (not a pull request) | success, `tested=true`        | failure        | failure                            | failure                   |
| failed                       | success, `tested=true`        | failure        | failure                            | failure                   |
| hit                          | success, steps skipped        | failure        | failure                            | failure                   |
| docs-only, no hit            | success, steps skipped        | failure        | failure                            | failure                   |
| miss                         | success, `tested=true`, saved | failure        | failure                            | failure                   |

While the run waits for a signed head, the shard job is skipped whole, and
`Playwright G3 scenarios (waits for a signed head)` passes, records nothing
and saves nothing. Should the shard job have any other result, or a shard
have set its `tested-<n>`, it fails. A cancelled run that waits shows
failure under that name if the shards were cancelled before GitHub skipped
them, and success under it if the cancellation came after. Neither is a
check named `Playwright G3 scenarios`.

And when the run is cancelled, in any of those rows:

| The run is cancelled      | `Playwright G3 scenarios`                                         |
| ------------------------- | ----------------------------------------------------------------- |
| before the shards start   | failure: the shards do not run, and GitHub reports them cancelled |
| while the shards run      | failure: the shards are cancelled                                 |
| after the shards ended    | the shards' result as above; `Record tree pass` does not run      |
| before this job can start | possibly cancelled, with no steps run, which does not pass either |

`Record tree pass` runs only in the first table's last row and first
column. A leg that recorded nothing fails the check on every row but a hit,
even if GitHub counted the shard job as passed. GitHub decides a matrix
job's `if` once for all its legs, so one leg is never skipped alone; the
shards do not run only when the run is cancelled, and GitHub then reports
them cancelled.

- **A cancelled run**, by a newer push or by hand: the shards stop and
  report cancelled, or, if they had not started, never run and are reported
  cancelled too, as the pending `Record tree pass` was in this workflow's
  runs 43954849598, 43952399971 and 43633805907. `Playwright G3 scenarios`
  has `if: ${{ always() }}`, so it runs even then, and the check does not
  depend on how GitHub reports a job that never started in a cancelled run:
  a cancellation that leaves a shard without success shows failure on the
  older commit, and one after every shard passed shows the shards' real
  result. In Qbit-Org/qbit run 43895928481, which a newer push to its pull
  request cancelled, that repository's `always()` gate started three seconds
  after the last of the jobs it needs ended cancelled, ran its steps and
  failed. A cancellation that lands before the job can start may still
  report it cancelled: in Qbit-Org/qbit run 43445632613, cancelled two
  seconds after it was created, its `always()` gate ended cancelled with no
  steps. That does not pass a required check either. Once it runs, the job
  cannot be cancelled, which costs nothing for a few shell lines; the
  shards, which are heavy, keep `!cancelled()` and stop.
- **A shard that hits its timeout** ends cancelled, but that does not make
  `cancelled()` true for the jobs that need it. In
  Qbit-Org/qbit-mining-bootstrap runs 36902925573 and 36904674276 a matrix
  leg exceeded its 30-minute `timeout-minutes` and ended cancelled; the job
  that needs the matrix, with `if: ${{ !cancelled() }}`, started about 10
  seconds later, ran its steps and failed, and the `always()` job after it
  did the same. Run 39335241109 shows the same with two jobs at their
  45-minute limit. So a timed-out shard fails `Playwright G3 scenarios`
  through its check step.
- **"Re-run failed jobs" after one shard failed** re-runs that leg and the
  jobs after it, and reuses the passing legs. The new
  `Playwright G3 scenarios` checks all five again, so a marker is recorded
  only if each one passed, in that attempt or the one it was reused from, on
  the same tree and the same decision. A leg that fails again fails the
  check. This relies on GitHub carrying the reused legs' outputs into the new
  attempt, as it carries `Tree pass marker`'s; if it did not, the check
  would fail and record nothing, and "Re-run all jobs" runs everything
  again.
- **A shard that fails during setup** (checkout, install, build, Docker) never
  sets its output, still uploads whatever report it has and stops its
  harness, and fails `Playwright G3 scenarios`.

Each shard builds the extension itself, the same steps as before the split:
sharing one build would add a job that the marker must also vouch for, and
it saves no time on the clock. The setup before the tests took about 4
minutes in run 43492510862 (2.7 of them for the extension build), so a full
run takes about 16 runner-minutes more than one job did, plus a few seconds
for `Playwright G3 scenarios`. On a marker hit, all five legs still start,
each only to run its gate.

Playwright splits by test count in file order, not by time, so the shards'
times drift as spec files grow: a file of many short tests counts for more
than one long scenario. To check the balance, compare each shard's
`Run browser release gate` step time in a recent run. Five shards were
chosen from two measured splits, each shard's wall time including the
harness reset before each test: 416, 96, 301, 490 and 217 s on `main`'s
53-test suite (pull request run 43949586486 into `main`), and 471, 71, 483,
466 and 229 s on `release/1.0.10`'s 59-test suite (pull request run
43933512767 into `release/1.0.10`). They are a snapshot. Changing the count
means changing the matrix and everything the wiring tests tie to it (see
[Changing it](#changing-it)).

Both marker jobs run `tree-pass-marker.mjs` on the runner image's own Node
(Node 22 on `ubuntu-24.04`; 22.23.4 in image 20261101.360), without
`setup-node`: the script loads only Node's built-in modules, which a test
checks, and needs nothing newer than Node 18 (global `fetch`,
`AbortController` and `DOMException`). Each API request times out on a timer
of its own, not `AbortSignal.timeout()`, whose timer does not keep the event
loop alive: a request left waiting on nothing else would let the loop drain,
and Node would end the step with exit 13 and no answer (a red
`Tree pass marker` and a full run) instead of a timeout and a full run. The
request also races its timer, so a `fetch` that ignores the abort still ends
at the deadline. A few failures turn the run red although both required
checks pass, because the covered jobs then run in full: a failed checkout or
an error in `Tree pass marker`, an invalid `TREE_PASS_SALT` on a pull request,
and a wiring error that `Record tree pass` refuses. A failed label or API read
never does; it only means a full run or no marker.

## Required checks in the skip path

The `main-protection` ruleset requires two checks:
`Typecheck, test, and build` and `Playwright G3 scenarios`. Release branches
require none.

- Both jobs keep running on a marker hit, with every step after the gate
  skipped (each also checks its lanes or shards), so each check reports
  **success**, not "skipped".
- Neither is a matrix job. The name of `Typecheck, test, and build` never
  changes; that of `Playwright G3 scenarios` changes only while a pull
  request run waits for a signed head, to
  `Playwright G3 scenarios (waits for a signed head)`, which is no required
  check. The waiting run reports no check under the required name, so where
  it is required (see
  [`.github/rulesets/README.md`](../.github/rulesets/README.md)) it stays
  pending, unless an earlier run on the same commit already reported it. The
  lanes of
  `Typecheck, test, and build` are jobs of their own, and the G3 shards are a
  matrix job, whose legs GitHub names `Playwright G3 shard <n> of 5`; none of
  them is a required check, and each required job reports the combined
  result of its lanes or shards.
- The lanes and the shards wait for `Tree pass marker` with
  `if: ${{ !cancelled() }}`, and `Typecheck, test, and build` and
  `Playwright G3 scenarios` wait for it and their lanes or shards with
  `if: ${{ always() }}`, so all of them run in full when the marker job
  fails or is skipped (every event but `pull_request`). GitHub's default
  `success()` would skip them instead, and [GitHub reports a job skipped by
  a failed dependency as passing a required
  check](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
- When a run is cancelled while `Tree pass marker` is queued or running, the
  lanes and shards report `cancelled`, not `skipped`, as observed in
  Qbit-Org/qbit-mining-bootstrap run 39335241123 and four other runs for jobs
  with `needs` and `if: ${{ !cancelled() && … }}`. GitHub counts only
  `success`, `skipped` and `neutral` as passing. Both required jobs run even
  in a cancelled run: each fails unless every lane or shard passed, shows
  their real result when the cancellation came after they all passed, and
  may show cancelled when the cancellation lands before it can start (see
  [Sharded G3 scenarios](#sharded-g3-scenarios)), which does not pass
  either. A `Tree pass marker` that hits its 10-minute timeout also ends
  cancelled, but a timed-out job does not make `cancelled()` true for the
  jobs that need it (Qbit-Org/qbit-mining-bootstrap runs 36902925573 and
  36904674276), so every covered job then runs in full.
- No workflow or script in this repository polls these checks.

## Landing a pull request

The skip pays off only if the run before the landing push saved its marker,
so wait for `Record tree pass` to succeed in `CI` before pushing the landing
commit, not only for the required checks. In `Browser release gate` it can
do so only if that head was signed: a run on an unsigned head waits for a
signed head and saves nothing, a run with `ci:full-run` never saves, and the
signed landing commit then runs G3 in full. It needs every covered job, the
G3 shards through
`Playwright G3 scenarios`, so it finishes after the last of them: about 15
seconds later in this pull request's first run, and longer when GitHub-hosted
runners are queued.

Both workflows cancel a running run of the same pull request when a new
commit arrives (`concurrency` on the merge ref with `cancel-in-progress`). A
landing push before `Record tree pass` finishes cancels the run that would
save the marker, and the landing commit then runs in full. A landing push
after it cancels at most `Dependency policy`, which the vouching run is not
judged by. If the base moves before the landing push, the landing commit's
merge tree, and so its key, differs from the one that passed, and it runs in
full as well.

If `Record tree pass` was skipped or declined (its summary says why), the
landing commit runs in full; nothing else changes.

## Forcing a full run

- **One run:** choose "Re-run all jobs". A re-run never skips (the
  `no later failure` rule), with or without the label.
- **One pull request:** add the `ci:full-run` label, then choose "Re-run all
  jobs", push, or close and reopen the pull request. While the label is on,
  runs neither use nor write markers. "Re-run failed jobs" reuses the first
  attempt's decision to skip or not, so it does not force a full run, but its
  `Record tree pass` reads the labels again and records nothing while the label
  is on. A maintainer creates the label once, under Issues → Labels.
- **One workflow:** bump `TREE_PASS_WORKFLOW_SALT` in that workflow file. The
  file is part of the tree, so this is a change like any other: it reaches a
  pull request once the pull request includes it, through its own branch or a
  moved base.
- **Everything, without a commit:** set or bump the `TREE_PASS_SALT` repository
  variable (Settings → Secrets and variables → Actions → Variables); unset, it
  counts as 0. Every run started after the change uses the new salt, so no
  earlier marker matches. A value that is not a whole number fails `Tree pass marker` on a
  pull request, which makes every job run; other events never read it.
- **One tree's markers:** list them with
  `gh cache list --key <prefix>` and delete each with `gh cache delete <key>`.

## When it never skips

- Any event other than `pull_request`: pushes to `main`, tags, release builds,
  `merge_group`, schedules and manual dispatches. `Tree pass marker` does not
  run at all for them.
- A pull request from another repository.
- A pull request with the `ci:full-run` label, or whose labels cannot be read.
- A tree that changed in any way, including the workflow files and this script,
  which are part of the tree under test.
- A moved base whose merge result differs.
- A head branch that another pull request has ever used, open, closed or
  merged, before or after this one. Pushing the reviewed head to a fresh
  branch and opening a new pull request makes markers usable again.
- A pull request with any base event on its timeline or among its issue
  events: retargeted by hand or by GitHub, or its base branch force-pushed or
  deleted while GitHub recorded it. Events are not removed, so such a pull
  request never skips again. Base force-pushes are routine on release
  branches here (qbit-wallet #136, #137 and #141 have them), so pull requests
  into such a branch often run in full every time.
- A pull request whose head branch was deleted or restored while it was
  open. It never skips again either.
- A marker whose run was created before the pull request, or in the same
  second.
- A later run of the same workflow on the head branch, with the same head
  tree, that failed, was cancelled or ended in any other way but success, or
  any such run that is still going. That includes a run the concurrency group
  cancelled because a newer commit with the same tree arrived, and a run
  where only `Dependency policy` failed. The full run that follows saves a
  newer marker, and later runs are judged from that one.
- A marker whose run GitHub now lists at a later attempt than the marker
  names: a re-run of it, including one started while the decision was under
  way.
- A re-run of any run with "Re-run all jobs", including one of the run that
  saved the marker.
- Any failure of the key, the lookup, the decision or GitHub's API.

## What remains possible

These are not prevented, and are accepted:

- **A run of a gutted workflow on the same head, through the base.** The
  checks bind the vouching run to this pull request and to the absence of
  base events on its timeline and among its issue events, but not to the
  base commit it merged with: GitHub's records do not name it, and ordinary
  pushes to the base leave no event. Someone who can push to the base branch
  can land a commit that changes the workflow, get a run of this pull request
  that merges with it (a push to the head, or closing and reopening), have
  that run report the covered jobs and `Record tree pass` as passed without
  testing anything, upload the artifact and save the key, and then land a
  commit that reverts the change. The honest run of the same head then skips.
  The faking need not happen while the base carries the change: re-running an
  old run reuses its original merge commit, so a run made then can be re-run
  later and its new attempt vouches. A release branch here requires only signed
  commits and may be deleted, so the change need not stay in any history;
  `main`'s rules can be bypassed by an administrator. A base branch that is
  deleted and re-created may leave no base event either. Write access already
  lets a job of a pushed workflow report a check run under a required check's
  name directly, so this adds no new capability. `ci:full-run` or the repository
  salt removes the doubt for any one pull request. Binding the base commit would
  need the save job's OIDC token, whose `sha` claim names the merge commit; it
  is not built.
- **A branch rename paired with a base whose workflow differs.** GitHub
  records nothing that names the pull request a run belonged to. A run's
  record names its head branch by the name it had when the run was created,
  and the rules above tie the run to this pull request only through that
  name, the head tree, the creation time and this pull request's recorded
  events. Someone with write access can get a run of another pull request,
  with this head's tree, into a base whose workflow they changed, so that it
  reports the covered jobs and `Record tree pass` as passed and uploads the
  artifact for a key they choose; plant that key in this pull request's cache
  with a changed workflow on an earlier push; and rename branches so that the
  name the run recorded is this pull request's head branch and only this
  pull request is listed from it. Whether GitHub records a rename as an event
  on either pull request was not checked; the rules look for none.
  Qbit-Org/qbit-mining-bootstrap#839 states the same limit. As with the
  gutted base above, write access already lets a job report a required check
  directly, and `ci:full-run` or the repository salt removes the doubt for a
  pull request.
- **What the run listing does not show.** The `no later failure` rule sees
  the runs GitHub lists for this workflow file, event `pull_request` and head
  branch name, and judges those whose head commit has this head's tree, each
  by its latest attempt (see "Earlier attempts of later runs are not read").
  A failure in another workflow, or of the same merge tree reached from
  another head, does not count. GitHub's `branch` filter matched `head_branch`
  when this was written (checked against this repository on 2026-11-13); a run
  it leaves out is not seen.
- **Inputs that are not in the tree** (see "What it covers") can change
  between the passing run and the skipped one.
- **A newer entry hides an older valid one.** The lookup returns only the
  newest entry under the prefix. If that entry fails the checks, for example
  one planted by a workflow that someone who can push to the pull request
  changed on an earlier push, or one from a run that was later re-run, the run
  runs in full. It then saves its own marker, which becomes the newest. Each
  such entry costs one full run. An entry that fails the checks never causes a
  skip; the first item above is one that passes them.
- **False alarms cost a full run.** A head branch name reused by any other
  pull request, even one closed long ago, any base event (a retarget by
  hand or by GitHub, a base force-push, which is routine on release branches
  here, or a deleted base) and a deleted or restored head branch make every
  later run of the pull request run in full, though nothing may be wrong. A
  later run of the tree that the concurrency group cancelled, or that failed
  only `Dependency policy`, costs one full run, which then saves a newer
  marker.
- **"Re-run failed jobs" can invalidate the marker.** If only
  `Dependency policy` failed in the run that saved the marker, re-running the
  failed jobs makes attempt 2 the latest, so the attempt-1 marker is refused.
  Attempt 2 reuses `Record tree pass` from attempt 1 and saves nothing, so the
  next run of that tree runs in full and saves again.
- **A landing push before `Record tree pass` finishes** cancels the run that
  would save the marker (see "Landing a pull request").
- **The workflow under review controls its own run.** Someone who can push to
  the pull request can change the workflow in the head commit itself; then the
  run that tests that head is theirs, with or without a marker. Reviewers see
  that change in the diff, and it changes the tree, so no earlier marker made
  for another tree applies to it.
- **GitHub is trusted:** the event payload (head commit, branch and
  repository), its run, job and artifact records, and the cache's scoping.
- **The vouching run's overall result is not judged.** A run whose covered
  jobs and `Record tree pass` passed in its latest attempt counts, even if
  `Dependency policy` failed in it, it was cancelled afterwards, or it is
  still finishing; `Dependency policy` runs again in every run. Later runs of
  the tree are judged by their overall result (`no later failure`).
- **Earlier attempts of later runs are not read.** The `no later failure`
  rule judges each later run of the tree by its latest attempt, the only one
  GitHub's run listing shows. A later run whose first attempt failed and
  whose re-run passed therefore counts as a pass, and the earlier failure
  does not stop the skip. Reading every attempt of every run of the tree
  would take a request per run (`GET …/runs/{id}/attempts/{n}`), so it is not
  done. This run's own earlier attempts are the exception: a re-run never
  skips.
- **Expiry.** The artifact is kept 14 days, and the cache drops entries not
  used for 7 days. Either way the next run runs in full and saves anew.

## Why the marker jobs run on GitHub-hosted runners

The other jobs here run on Blacksmith. Their logs print
`Enabling Blacksmith transparent cache`, and on 2026-11-10 GitHub's cache API
listed no entries for this repository although every job saves the pnpm store.
So `actions/cache` on a Blacksmith runner stores entries with Blacksmith, under
rules GitHub does not document. The marker relies on GitHub's documented cache
scoping, so both marker jobs run on `ubuntu-24.04`, which uses GitHub's cache.
These jobs take seconds, run only for pull requests, and the repository is
public.

## What GitHub's cache guarantees, and what it does not

From [GitHub's dependency caching
reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching):

- A cache created by a `pull_request` run "is created for the merge ref
  (`refs/pull/.../merge`)", "can only be restored by re-runs of the pull
  request", and "cannot be restored by the base branch or other pull requests
  targeting that base branch". So a marker from one pull request is invisible to
  every other pull request and to every branch.
- Caches created by a `pull_request` run "cannot be written to the default
  branch's scope".
- "You cannot change the contents of an existing cache". Each run saves under
  its own key in any case.
- Entries not accessed in over 7 days are removed, and a repository over its
  size limit evicts entries. Either way the next run misses and runs in full.
- With [`cache-mode`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode)
  (`read`, `write`, `write-only` or `none`), "access is enforced with scoped
  cache tokens", and a save the mode does not allow "is simply not performed".
  `Tree pass marker` has `cache-mode: read`, so it cannot save anything, and
  `Record tree pass` has `write-only`.

What it does not guarantee:

- A pull request run can also restore caches from its base branch and the
  default branch. Markers are only ever saved by `pull_request` runs, so those
  scopes hold none. An entry a workflow there saved must still name a
  `pull_request` run from this pull request's head branch whose head commit
  has this head's tree, of this pull request alone, or the checks refuse it.
- "Cache contents are not signed or verified." Any job that runs in a pull
  request's scope can save any key there, including a job in a workflow the pull
  request itself changed on an earlier push. That is why the decision never
  restores an entry and trusts nothing in it but the run it names, and only
  after GitHub's own records of that run, its jobs, its artifact, the pull
  requests from its head branch, this pull request's timeline and issue
  events, and the later runs of its head tree agree.

## Checking a marker

Markers appear in the GitHub cache list with the pull request's merge ref:

```sh
gh cache list --repo Qbit-Org/qbit-wallet --key tree-pass-v1- --json key,ref,createdAt
gh api "repos/Qbit-Org/qbit-wallet/actions/runs/<run ID>/artifacts" --jq '.artifacts[].name'
```

Each run's `Tree pass marker` summary shows the key prefix, whether markers
were used, the decision and, on a skip, the passing run. The gate step of each
required job repeats that run's URL. `Record tree pass` shows the full key and
the artifact it recorded, or why it declined.

## Changing it

- `node --test scripts/security/tree-pass-marker.test.mjs` covers the key, the
  checks of the named run against a simulated GitHub, each binding rule by
  name with its unreadable and cut-short listings, the decision table, the
  record step, and the workflow wiring. The wiring tests fail if a covered
  step loses its gate, a required job becomes skippable, the save job misses a
  covered job, a marker job moves off GitHub-hosted runners, the lookup
  stops being lookup-only, or any other step in a marked workflow uses
  `actions/cache/restore` or `actions/cache/save`, directly or through a local
  composite action. Other workflows and every tracked `action.yml` must not
  mention the marker or those sub-actions at all. They also evaluate the
  workflows' `if` conditions for a skipped, failed, skipping and full
  `Tree pass marker`. For the G3 shards they fail if a leg loses its gate,
  its own output, its upload or its harness teardown, if the matrix is not
  exactly `1` to `n` or anything else uses another total, if
  `TREE_PASS_COVERED_JOBS` misses a leg, or if `Playwright G3 scenarios`
  loses `if: ${{ always() }}` or `permissions: {}`, becomes a matrix job, or
  stops checking a shard. For the lanes of `Typecheck, test, and build`
  they fail if a lane loses its gate or its `tested`, if the save job or
  `TREE_PASS_COVERED_JOBS` misses a lane, or if `Typecheck, test, and build`
  loses `if: ${{ always() }}` or `permissions: {}`, becomes a matrix job,
  stops needing or checking a lane, or names a lane other than by its job's
  name. No covered job, nor any of its steps, may carry
  `continue-on-error`. They run each leg's suite command through a stand-in
  `xvfb-run`, and each check step for every state of `Tree pass marker`
  crossed with shards or lanes that passed, failed, were cancelled or
  skipped, or lost their outputs, and with the run cancelled before, while
  or after they run, to the tables in
  [Sharded G3 scenarios](#sharded-g3-scenarios). They also pin the docs-only
  step, its output, each gate's `DOCS_ONLY` input and the save job's
  condition ([Docs-only changes](ci-docs-only.md#changing-it)). For G3 they
  pin the signed-head step, its settings and output, the shard job's and the
  save job's conditions, and the computed name of
  `Playwright G3 scenarios`, which they render in every state of
  `Tree pass marker`; they run the waiting cases, with the step's decision
  computed by the script itself, and fail if any of them gives a passing
  check named `Playwright G3 scenarios`.
  `node --test scripts/security/signed-head-gate.test.mjs` covers the
  decision itself.
- The dependency policy (`scripts/security/dependency-policy.mjs`) accepts
  those two sub-actions only in `ci.yml` and `playwright-release-gate.yml`,
  never in a local action or another workflow, and
  `scripts/security/dependency-policy.test.mjs` allows them there only as the
  exact lookup in job `tree-pass` and the exact save in job `tree-pass-save`.
  Its Corepack rules read through local composite actions, so any other
  `actions/cache` step, there too, must be a pnpm store cache that follows
  them.
- `pnpm test:security-tooling` runs it with the other policy tests, and the
  `Dependency policy` job runs that on every event.
- To cover another job, add it to the save job's `needs` and to
  `TREE_PASS_COVERED_JOBS` in the decide step, give it the gate (or, if it is
  not a required check, the job-level `if`), the `tested` output and the last
  step, and add it to the test's `MARKED_WORKFLOWS`.
- To change the number of G3 shards, change the matrix list and, to match,
  the total in `--shard` and the job name, the `tested-<n>` outputs, the
  check step's environment and list, and the leg names in
  `TREE_PASS_COVERED_JOBS`; the wiring tests name whichever was missed. A
  covered matrix job other than the shards goes in `MARKED_WORKFLOWS` under
  `sharded`, with the job that aggregates it.
- To add, remove or rebalance a lane of `Typecheck, test, and build`, change
  the lane jobs and, to match, the needs, the check step's environment and
  list in `Typecheck, test, and build`, the save job's needs,
  `TREE_PASS_COVERED_JOBS`, and `stepGated` and `lanes` in the test's
  `MARKED_WORKFLOWS`; the wiring tests name whichever was missed. A package
  given a lane of its own must also be excluded from the third lane's
  `--filter` list, or its tests run twice.
