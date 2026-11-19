# Docs-Only Changes

A pull request that changes only documentation still ran every expensive
step: the four lanes of `Typecheck, test, and build`, about 5 minutes each,
and five G3 shards of about 12 minutes each, each on a runner of its own.
Most of those steps never read the files such a pull request changes. On a
pull request that changes only documentation that no skipped step reads,
those steps are skipped the way a
[tree pass marker](ci-tree-pass-marker.md) skips them, and every required
check still reports success. The one lane whose tests do read every file,
documentation included, still runs in full.

For G3 only, a pull request that sets the extension version and changes
nothing else but such documentation counts as well: see
[Version bumps](#version-bumps).

The logic is in
[`scripts/security/docs-only-change.mjs`](../scripts/security/docs-only-change.mjs),
with its tests next to it. The workflows only wire it in.

## What is skipped

| Workflow                      | On a docs-only change                                                                                                                                                                                                    | Still runs in full                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                      | the lanes `Unit tests: qbit-extension`, `Unit tests: wallet-background` and `Build and reproduce the extension` run only their gates; `Typecheck, test, and build` runs its gate and its check that every lane succeeded | the lane `Typecheck, security checks and other unit tests` (`verify-workspace`), `Lint`, `Dependency policy`, `Tree pass marker` |
| `playwright-release-gate.yml` | each `Playwright G3 shard <n> of 5` runs only its gate; `Playwright G3 scenarios` runs its gate and its check that every shard succeeded                                                                                 | `Tree pass marker`                                                                                                               |

Other workflows do not use it. `Record tree pass` does not run: nothing was
tested, so there is no pass to record, and a docs-only run never saves a tree
pass marker. As with a marker skip, a docs-only run produces no
`chrome-mv3-extension` build and no Playwright reports.

**Why `verify-workspace` always runs.** It runs `pnpm test:security-tooling`,
which includes tests that read every tracked file, documentation included:
`former-owner.test.mjs` reads their contents, and `codeowners.test.mjs` their
names. A reader that walks the whole tree names no file, so no allowlist can
leave it out, and the tripwire below cannot see it. `Dependency policy` runs
the same tests, but it is not a required check, and it can be red for reasons
outside the tree, such as a new advisory. So `verify-workspace`'s gate has no
docs-only branch: only a marker hit skips it, and a documentation change that,
say, names the repository's former owner still fails
`Typecheck, test, and build`. The wiring tests tie this to the jobs that run
`test:security-tooling` (see [Changing it](#changing-it)).

`Lint` and `Dependency policy` keep running too.

In `playwright-release-gate.yml` a [version bump](#version-bumps) is skipped
the same way. In `ci.yml` it runs in full.

## How a run decides

`Tree pass marker`, which runs only for `pull_request` events, ends with the
step `Check for a docs-only change`. It runs `docs-only-change.mjs`, which sets
the job output `docs-only` to `true` only when all of these hold:

1. The event is `pull_request`. Pushes and manual dispatches never run the
   job, and always run in full.
2. The pull request does not carry the `ci:full-run` label
   (`TREE_PASS_FORCE_LABEL`, compared without case). The labels are read from
   the API when the job runs, as the marker reads them, so a label added
   later counts when the run is re-run with "Re-run all jobs". Labels that
   cannot be read mean a full run.
3. `GITHUB_SHA`, GitHub's merge of the head into the base
   (`refs/pull/<number>/merge`), has exactly two parents, and the second is
   the pull request head. The first is the base it merged into. The job's
   checkout fetches a depth of 2, which holds both.
4. `git diff --raw --find-renames --find-copies` from that base to the merge
   lists between 1 and 200 files. Each one was added or modified, not renamed,
   copied, deleted or changed in type; is a regular, non-executable file
   before and after (mode `100644`, so no symlink, submodule or executable);
   and is in the allowlist below. `git diff --numstat --no-renames` must list
   the same files, and none of them as binary.

The comparison is the tree the run tests against the base it merged into. A
branch that is behind its base counts only its own changes, and a change
pushed and then reverted counts for nothing.

Where the step sets `DOCS_ONLY_VERSION_BUMP` to `true`, which only
`playwright-release-gate.yml` does, the two version files may change as well,
under the rules in [Version bumps](#version-bumps).

Anything else sets `false`, which is a full run. That includes an empty diff,
more than 200 files, any git or API error and any output git gives that does
not parse; the step's summary and notice give the reason, on one line. A
wiring error fails the step and so `Tree pass marker`, which also means a
full run: an unset or malformed `TREE_PASS_FORCE_LABEL`, a
`DOCS_ONLY_VERSION_BUMP` that is set to anything but `true` or `false`, a
commit that is not an object ID, or a missing or malformed setting the label
read needs (the token, the API URL, the repository or the pull request
number).

Every gate step except `verify-workspace`'s reads the output next to the
marker's `skip`:

```yaml
- name: Check for a tree pass marker
  id: gate
  env:
    MARKER_JOB_RESULT: ${{ needs.tree-pass.result }}
    MARKER_SKIP: ${{ needs.tree-pass.outputs.skip }}
    MARKER_RUN_URL: ${{ needs.tree-pass.outputs.run-url }}
    DOCS_ONLY: ${{ needs.tree-pass.outputs.docs-only }}
```

It skips when `Tree pass marker` succeeded and said `skip` (a marker hit,
whose summary names the passing run) or, failing that, when it succeeded and
said `docs-only`. Its summary then says that the pull request changes only
documentation and how to run everything; the summary of
`Typecheck, test, and build` also says that `verify-workspace` ran in full. A failed, cancelled or skipped
`Tree pass marker` runs everything, whatever its outputs say.
`Record tree pass` has
`if: needs.tree-pass.outputs.save == 'true' && needs.tree-pass.outputs.docs-only != 'true'`,
and in `playwright-release-gate.yml` also
`&& needs.tree-pass.outputs.signed-head-wait != 'true'`.

In `playwright-release-gate.yml`, `Tree pass marker` has one more step after
this one, `Check whether the head commit is signed`, which decides whether G3
[waits for a signed head](playwright-release-gate.md#signed-heads). For G3 a
pull request run decides in this order, and the first rule that applies
settles it:

1. The `ci:full-run` label: G3 runs in full.
2. A marker hit: the shards skip their steps.
3. A docs-only change, which here includes a version bump: the shards skip
   their steps.
4. A head commit whose signature GitHub has not verified: G3 waits for a
   signed head, and no shard starts.
5. Otherwise G3 runs in full.

So a docs-only change never waits for a signed head, signed or not. The
signed-head step looks at the marker's and this step's verdicts before
anything else, so on a marker hit or a docs-only change it sends no request
at all. Any doubt in the
signed-head decision runs G3 in full. The gate of `Playwright G3 scenarios`
reads the wait after its marker-hit and docs-only branches, and a wait never
sets `skip`.

The run's summary tells the three cases apart: `Tree pass marker` shows the
marker decision and, under "Docs-only change", the verdict with its reason and
the files; a skipping gate says which of the two skipped it; a full run's
gates write nothing.

## The allowlist

| Path                                                         | Why no skipped step reads it                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/**/*.md`, except `docs/pqc-derivation.md`              | No build, package, lint, workflow or skipped test reads markdown under `docs/` (see the search below). The release notes in `docs/releases/` are not bundled into the extension; its version notices are code. |
| `README.md`, `CONTRIBUTING.md` and `SECURITY.md` at the root | The root package is private and never packed. Only the whole-tree tests read them, and they run in `verify-workspace`.                                                                                         |

Each path segment must start with a letter or a digit and hold only letters,
digits, `.`, `_` and `-`, and the extension must be `.md` in lower case.
Hidden files, other spellings and anything git quotes are not on the list.

Everything else runs in full. These were looked at and left out on purpose:

| Path                                                          | Reader                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/pqc-derivation.md`                                      | `pqc.yml` runs the PQC conformance workflow on every change to it, as part of the PQC contract                                                  |
| `docs/security/*.json`                                        | the dependency policy and `generate-dependency-evidence.mjs` check the audit and the inventory against the lockfile (and they are not markdown) |
| `.changeset/**`, `packages/*/.changeset/**`                   | changesets: `changeset version` and `changeset status` read them                                                                                |
| `**/CHANGELOG.md`                                             | `changeset version` writes them, and they ship with the packages                                                                                |
| `packages/*/README.md`                                        | each package lists its README in `files`, so it is published                                                                                    |
| `apps/**`                                                     | the extension and the demo app; `pqc.yml` also runs on any change under `apps/extension/`                                                       |
| `LICENSE`, `apps/extension/LICENSE`                           | license texts, which packaging includes                                                                                                         |
| `.github/**`                                                  | GitHub reads the workflows, CODEOWNERS, the rulesets and the pull request template                                                              |
| everything else, such as `tests/`, `scripts/`, `experiments/` | not judged: such files sit beside code that may read its own directory                                                                          |

### How the readers were found

At `ab0cec6b` on 2026-11-17, every tracked file that is not markdown was
searched for the `docs` directory, markdown paths and extensions, `README`,
`CHANGELOG`, `LICENSE`, `NOTICE`, `SECURITY` and `CONTRIBUTING`, and for
whole-tree reads (`git ls-files`, `readdirSync`, globs). What reads which
files:

- **Whole-tree tests and checks.** `former-owner.test.mjs` reads every tracked
  file, `codeowners.test.mjs` lists every tracked path, and the dependency
  policy lists every tracked file for its reachability guard, which treats
  markdown as never executed. The first two run in `verify-workspace`, and
  all of them in `Dependency policy`; a docs-only change skips neither.
- **Lint.** `scripts/lint.mjs` runs ESLint on `.cjs`, `.js`, `.mjs`, `.ts` and
  `.tsx` files, and each workspace's lint script runs ESLint on its `src`
  (and one on its `test`); nothing checks markdown. `Lint` runs on a
  docs-only change anyway.
- **The skipped lanes.** The builds, the unit tests and the extension package
  read no markdown: the extension build copies `apps/extension/build/_raw`,
  which holds none, and no source file imports a markdown or text file. No
  test names a document under `docs/`, including this one and
  `ci-tree-pass-marker.md`. Release readiness, which runs in
  `verify-workspace`, reads named Dockerfiles, workflows, the regtest compose
  file and `core-pin.json`.
- **Packaging and releases.** Package READMEs are in their `files`, CHANGELOGs
  belong to changesets, and `.changeset/` is read by changesets.
  `Package versions applied` reads the names in `.changeset/` and the two
  version files, and is never skipped.
- **Workflows.** `pqc.yml`'s `paths` name `docs/pqc-derivation.md`; no other
  workflow names a document outside a comment.

## Version bumps

The pull request that prepares a release sets the extension version in two
files and adds a line to the release notes. It is not docs-only, so G3 ran
its five shards for it, although no scenario depends on which version the
extension has. In `playwright-release-gate.yml` such a pull request counts as
a docs-only change: the step `Check for a docs-only change` sets
`DOCS_ONLY_VERSION_BUMP` to `true` there, and `docs-only` is then `true` also
when all of these hold:

1. Every changed file is either in the allowlist above or one of the two
   version files, `apps/extension/package.json` and
   `apps/extension/build/_raw/manifest/_base_v3.json`, and the rules of
   [How a run decides](#how-a-run-decides) hold for all of them.
2. Both version files are modified. The build takes the version from
   `package.json` alone, so nothing else would notice the base manifest's
   falling behind.
3. Each version file differs from the base in one line, and as JSON only in
   the value of its top-level `version`. Both are read from the base and from
   the merge under test.
4. Each raises its version from one `x.y.z` version to a higher one, and both
   set the same. Each part is a number from 0 to 65535, the highest Chrome
   accepts in a manifest, with no leading zero. A package version with a
   `-beta` suffix is not of that form, so a change to or from one runs in
   full.
5. Neither version-keyed source below, read from the merge under test, holds
   that version anywhere in its text, and the wallet configuration sets
   `version` once, to the empty string.

The summary of `Tree pass marker` then says "as a version bump" and gives the
version. The gates' summaries in this workflow say "only documentation that no
skipped step reads, or only that and the extension version". The label
`ci:full-run` runs everything, as for a docs-only change.

**What reads the version.** At `2821d9ee` on 2026-11-19:

| Reader                                                   | What it does with the version                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/extension/gulpfile.js`                             | takes it from `package.json`, names the package after it, and writes it into the built manifest over the base manifest's own                                                |
| `apps/extension/build/webpack.common.config.js`          | defines it as text in the bundle, which the About and Settings screens and a recovery error report show                                                                     |
| `useVersionInfo` in `@qbit/wallet-state`                 | compares it with the bundled wallet configuration's `version`, which is empty, so no update prompt shows                                                                    |
| the home screen's "what's new" notice                    | after an update, shows the bundled notice whose key is the running version; there is none                                                                                   |
| `scripts/reproducible-extension-build.mjs`, package test | name the package after it, and check the built manifest's version against `package.json`; they run in `Build and reproduce the extension`, which a version bump never skips |
| the G3 scenarios                                         | one page object finds the About screen's label by its "Version: " prefix; none names a version                                                                              |

**Version-keyed sources.** Two bundled files can make a release act on its own
version, both in `packages/wallet-background/src/config/`:

- `local-version-notices.ts` holds the notices, keyed by the version that
  shows them. A notice for the next release is added while the extension
  still has the earlier version, so the pull request that sets the version is
  the first whose build shows it. Rule 5 runs G3 in full for it: a version
  bump to a version that appears anywhere in the file, in a comment or as
  part of a longer one, runs in full.
- `local-wallet-config.ts` holds the `version` that the update prompt compares
  with the running one, by order. A version bump can cross that version
  without naming it, so a version bump counts only while the file leaves it
  empty, which turns the prompt off: its text must hold the word `version`
  once, as `version: ''`. Anything else there runs every version bump in
  full.

**Why only G3.** The lanes of `Typecheck, test, and build` build and package
the extension under its version, and check the built manifest's version
against `package.json`, so `ci.yml` does not set `DOCS_ONLY_VERSION_BUMP` and
runs a version bump in full. The wiring test fails if a workflow that runs the reproducible build
sets it, and if anything but the step itself does, since a step inherits its
workflow's and its job's settings.

## A tripwire for new readers

Which files no skipped step reads is a judgment, and a later change can
start reading one. `docs-only-change.test.mjs` fails when a tracked file that
is not markdown names, in any quoted or template string (or any word of a
workflow outside its comments):

- a `docs` path segment anywhere: `'docs'`, `'docs/api'`, `'docs/**'`,
  `'../../docs/privacy.md'` in `new URL(…, import.meta.url)`,
  `` `${root}/docs/privacy.md` ``, or the `'docs'` in
  `join(root, 'docs', 'privacy.md')`. A string that names one file the
  allowlist does not hold, such as `docs/security/dependency-audit.json` or
  `docs/pqc-derivation.md`, does not count;
- `README.md`, `CONTRIBUTING.md` or `SECURITY.md` at the end of any string,
  such as `'../../README.md'` in a copy rule;
- markdown in general: `'.md'` or `'**/*.md'`.

Each string it finds today is a reviewed exception in `REVIEWED_MENTIONS`,
with its file and the reason: each package's `"README.md"` in its `files`,
made-up names and fixture paths in four tests, pnpm's `docs` command and
the reachability guard's `.md` in the dependency policy, and an error message
in the release-storage capture spec. An exception that no longer matches
anything fails the test too.

When it fails, look at the new reader. If it reads the files, take them out
of the allowlist in `docs-only-change.mjs` and in the table above; if it does
not, add an entry to `REVIEWED_MENTIONS` with the reason. Each word of a
quoted string counts on its own, so a path inside a command string, such as
`'markdownlint docs/**/*.md'`, is found too.

The test cannot see:

- a reader that builds the path from parts it does not name;
- a path that is not quoted outside a workflow, such as `cat docs/x.md` in a
  shell script, a Dockerfile, or a YAML file outside `.github/workflows`;
- a reader that walks every tracked file, as `former-owner.test.mjs` does.

That last case is why `verify-workspace`, which runs those tests, never skips
on a docs-only change. A review of a change that adds a reader of any of these
kinds still needs to check the allowlist.

## Forcing a full run

Add the `ci:full-run` label, then choose "Re-run all jobs", or push. "Re-run
failed jobs" reuses the first attempt's `Tree pass marker` and its decision,
so it does not force a full run. The label also turns off markers (see
[Forcing a full run](ci-tree-pass-marker.md#forcing-a-full-run)).

## What remains possible

- **The base is not tested again.** The checks of a docs-only pull request say
  that its change cannot break what the expensive steps check, not that the
  base passes them. Each base commit was tested through its own pull request,
  and pushes to `main` run in full. A release branch's tip is tested only
  through pull requests into it, and its pull request into `main` changes code
  and runs in full.
- **A reader the search missed** sees a changed document only on the next
  full run. The tripwire above narrows this, and `ci:full-run` removes the
  doubt for one pull request.
- **Code that acts on the version outside the two version-keyed sources**,
  such as a storage migration that compares the running version with a
  literal, is not seen by a version bump's G3 run. No tripwire covers it. The
  release branch's pull request into `main` runs G3 in full on the new
  version before the release is tagged.
- **Inputs outside the tree** do not matter here: the steps did not run.
- **Pull requests from forks** are judged the same way. The verdict comes
  from the merge commit under test and the labels, never from a cache, so it
  needs none of the marker's binding rules.

## Changing it

- `node --test scripts/security/docs-only-change.test.mjs` covers the
  allowlist, the parsing of git's listings, real pull requests in a throwaway
  repository (documentation, code, a mixed change, an excluded document, an
  empty change, renames, copies, deletions, an executable file, symlinks, a
  submodule, binary files, too many files, a merge that is not the head's, a
  checkout without the base), the label, the event, API failures, wiring
  errors, a reason over several lines, the command line and the tripwire. It
  also covers version bumps: alone and with documentation, with the setting
  on, off and malformed, each way a version file can change in more than its
  version, versions that differ, are not `x.y.z`, have a part above 65535 or
  do not go up, a notice that names the version, a configuration whose
  version is not empty, and a version-keyed source that is missing. `pnpm test:security-tooling` runs it, and the
  `Dependency policy` job runs that on every event.
- `scripts/security/tree-pass-marker.test.mjs` pins the wiring: the step and
  output in `Tree pass marker`, the `DOCS_ONLY` input and the summary of every
  gate (each lane, each shard and both required jobs), the save job's
  condition, that `Lint` still runs, and how the jobs end on a docs-only
  change, with and without a marker hit, and with a failed or cancelled
  `Tree pass marker`. Its outcome tables for `Typecheck, test, and build` and
  `Playwright G3 scenarios` include a docs-only change, which ends as a
  marker hit does for every way the lanes or shards can end.
- The exemption is explicit: `runsOnDocsOnly` in that test lists
  `verify-workspace`, and the test fails unless it lists exactly the
  step-gated jobs that run `test:security-tooling`, each of them a lane of the
  required check, with a gate that has no docs-only input or branch. A job
  that starts or stops running the security tooling tests must change the
  list, and its gate, with it.
- To gate another job, give its gate step the `DOCS_ONLY` input and the same
  script as the others; the wiring tests check every gate in the marked
  workflows.
- `versionBump` in the same test says which workflows set
  `DOCS_ONLY_VERSION_BUMP`. The test checks the step's settings and the
  wording of each gate against it, that nothing else in the workflow sets it,
  and that no such workflow runs the reproducible build. A new file that holds the version goes in
  `VERSION_FILES`, and a new source that acts on it in
  `VERSION_KEYED_SOURCES`, both in `docs-only-change.mjs` and above.
