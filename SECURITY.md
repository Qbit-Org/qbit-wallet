# Security policy

Qbit Wallet holds user keys and signs transactions. We treat any issue that
could lead to loss of funds, unauthorized signing, or exposure of secret
material as a priority.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
problem.**

Report it privately by email to **contact@qbit.org**, with
`qbit-wallet security` in the subject. This is the only reporting channel
for now: GitHub private vulnerability reporting is not yet enabled for this
repository. Email is not encrypted, so keep the first message short and we
will reply to agree a private way to continue.

Once private vulnerability reporting is enabled, you will also be able to
report through GitHub:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Fill in the advisory form.

Please include:

- the affected commit, release version, or extension build;
- the component and file paths involved;
- what an attacker needs (for example, a malicious website, a hostile API
  server, local access, or a tampered dependency);
- the impact: what the attacker can do that they should not be able to;
- steps to reproduce, ideally a minimal test or script against the local
  regtest harness (`pnpm regtest:up`); and
- for signing or approval issues, what the approval screen showed and the
  exact bytes that were signed.

A report does not need all of this to be useful. Send what you have.

Send a separate report for each distinct issue, so each one can be tracked and
fixed on its own.

**Never send seed phrases, private keys, passwords, or a real user's wallet
data**, even your own. Use regtest or test wallets in your reproduction. If you
need to share a sensitive file, ask us first and we will arrange a secure way
to send it.

## What to expect

- We acknowledge your report within 3 business days.
- We confirm or reject the issue, and give it a severity, within 10 business
  days, or tell you what more we need.
- We fix confirmed issues as fast as their severity calls for. How long a fix
  takes depends on the issue and on browser store review, so we do not promise
  a fixed date.
- We publish an advisory after a fixed release is available and users have had
  a reasonable chance to update.

We will keep you updated as we work on the issue. We credit reporters in the
published advisory unless you ask us not to.

We do not currently run a paid bug bounty.

## Severity

We rate issues using the scale in [`docs/threat-model.md`](docs/threat-model.md):

- **P0, critical:** broad key or fund loss, unauthorized signing, PQC
  signature-counter reuse, or release supply-chain compromise with little or no
  user interaction.
- **P1, high:** a realistic attacker crosses a wallet trust boundary, for
  example signing bytes that differ from what the user approved, bypassing
  site permissions, or exposing custody secrets.
- **P2, medium:** a meaningful weakness with real prerequisites or a
  compensating control.
- **P3, low:** hardening and low-impact issues.

You are welcome to suggest a severity. We set the final rating after we
reproduce the issue, and we will explain it if it differs from yours.

## Scope

In scope:

- the browser extension in `apps/extension`;
- the wallet packages in `packages/`, especially `keyring-service`,
  `wallet-core`, `wallet-background`, `approval-service`, and
  `permission-service`;
- the pinned `@qbit-oss/protocol`, `@qbit-oss/api` and `@qbit-oss/pqc` npm
  packages as they are used by this wallet;
- the provider API that websites use to talk to the wallet;
- vault encryption, key derivation, backup, and restore; and
- the build, packaging, and release pipeline, including GitHub Actions
  workflows and reproducible builds.

Report these to their own repositories instead:

- Qbit Core: [Qbit-Org/qbit](https://github.com/Qbit-Org/qbit)
- Qbit Electrs: [Qbit-Org/qbit-electrs](https://github.com/Qbit-Org/qbit-electrs)

Out of scope:

- issues that need a compromised operating system, browser, or an unlocked
  device already in the attacker's hands;
- phishing sites that the user approves after clear warnings;
- missing security headers or best-practice notes with no demonstrated impact;
- denial of service against public infrastructure; and
- findings from automated scanners without a working attack path.

## Supported versions

We fix security issues in the latest published release of the extension and
in the `main` branch. Older releases do not receive fixes. Please update to
the latest version.

## Testing rules

- Test only against your own wallets, the local regtest harness, or test
  networks.
- Do not access, move, or change funds or data that belong to other people.
- Do not run denial-of-service attacks or automated scans against shared
  infrastructure.
- Keep the issue and its details private until we confirm that a fix has
  shipped, or until we agree a disclosure date with you in writing.
- Do not sell or share an unfixed issue with anyone else, and do not make your
  report conditional on payment or other terms.

As far as we have the authority to do so, we treat research that follows this
policy as authorized, and we will not take legal action over accidental,
good-faith breaches of it. We keep all legal remedies for serious breaches of
this policy or of the law. If a concern comes up, we will first try to resolve
it with you directly.

This policy does not authorize testing of systems that other parties own, and
it does not bind them.

## Security documentation

- [Threat model](docs/threat-model.md)
- [Accepted risks](docs/security/accepted-risks.md)
- [Reproducible builds](docs/reproducible-builds.md)
- [Dependency review](docs/security/dependency-review.md)
