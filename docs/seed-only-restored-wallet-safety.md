# Seed-only restored Qbit wallet safety

Mnemonic restoration reconstructs a lower bound for each P2MR signature counter
from visible chain history. It cannot recover message signatures or
transactions that were signed but never broadcast. The wallet therefore treats
the restored keyring as a distinct custody state rather than presenting its
counter as exact.

Reconstruction reads each address's complete history where it can. An
address whose statistics show a history too long to enumerate (over 6,400
transactions, or more pending transactions than an Esplora mempool listing
returns) takes its floor from those statistics instead: its count of spent
outputs, the number the full read must match before it accepts a floor. The restore report names those accounts. Message signatures
and never-broadcast transactions stay invisible to both reads. See
[PQC Signature Counter Lifecycle](pqc-counter-lifecycle.md#restore-safety).

## Durable state

The encrypted Qbit keyring payload stores a versioned recovery state. Since
version 2 that state is kept **per network**, keyed by network name rather than
coin type: testnet4 and regtest share coin-1 keys but are separate chains with
separate UTXOs, so each network carries its own discovery completeness,
migration record, and archive. Each network's record moves through:

- `seed-only-restored`: the restored keyring is usable only after floor
  reconstruction. Its persistent warning may be compacted after the user
  explicitly acknowledges continued use, but the custody state remains. The
  acknowledgement itself stays seed-level: the exposure hazard is the
  mnemonic, not any one chain.
- `migrating`: a fresh destination Qbit seed/keyring exists and the encrypted
  source record retains every prepared, signed, broadcast, or confirmed sweep
  plan for this network.
- `migrated`: every recorded movement on this network is confirmed and a final
  source scan finds no protected or economically spendable balance at the
  relay-fee floor. The recovered keyring remains available but is archived for
  this network; sibling networks that still await their own sweep keep their
  keys signable.

Existing restored vaults without this field default to `seed-only-restored`
with acknowledgement required. Invalid or incomplete migration metadata also
fails back to that warning state. Single-network version-1 vaults upgrade on
load: a recorded migration files the version-1 lifecycle under its network, a
migration-less vault files under the coin type's network (coin 1 cannot
distinguish testnet4 from regtest, so discovery completeness is conservatively
reset for both siblings — discovery is resumable), and every untouched network
comes back `seed-only-restored`. This upgrade is what un-strands wallets whose
version-1 archive covered only the network that was active during restore.

The separate observed chain-floor record is monotonic. Counter updates use the
maximum of the local counter, observed chain floor, and imported counter. A
restored key retains `restored-floor` provenance after local signing; local
post-restore activity does not make the historical floor exact. Only the
separate keyring created from a fresh seed has local provenance.

## Signing enforcement

The keyring service, not an individual approval screen, enforces restored-floor
confirmation for every local P2MR signature. Preflight issues a short-lived
challenge bound to the exact pubkey and deterministic signature-cache keys.
The signer consumes that challenge once, including for a cache hit. Lock,
restart, expiry, request changes, or counter changes require a fresh review.

Approvals show:

- `Recovery status: seed-only restored`;
- `Counter confidence: chain floor only`; and
- known on-chain usage as `N+`, never as an exact remaining budget.

Acknowledging the persistent home warning never suppresses per-signature
confirmation. While migration is active, the recovered keyring may sign only a
PSBT already persisted as a reviewed migration plan or an exact provider PSBT
whose inputs are all independently verified at preflight as signable by the
recovered wallet, currently unspent, and protected. That protected-asset escape
still requires the normal in-extension transaction review and exact-request
restored-floor confirmation. The second escape is a consolidation batch of a
source account whose outputs the migration cannot read to plan them: the
explorer will not list them and its history is longer than the wallet reads.
The keyring signs such a batch only when the controller attests that, only if
the batch spends nothing but that account's own outputs and pays all of it back
to the same script, less a fee no higher than the wallet's highest fee rate
allows, and only while no plan of that source is open. It checks
the last condition again when it signs. See
[Explorer UTXO listing limit](explorer-utxo-limit.md). Message signing, mixed
protected-and-ordinary or collaborative inputs, and unrelated provider PSBTs
remain blocked.

The read-only archive applies per network through the effective status of the
currently derived keys: they refuse to sign only once every network sharing
their coin type has archived. A mainnet archive therefore makes coin-0 keys
read-only immediately, while a regtest archive leaves the shared coin-1 keys
signable until testnet4 has also been swept — those keys must keep signing to
move the sibling network's funds. Any sibling still `migrating` keeps the keys
migration-locked (reviewed plans only), which fails safe for ordinary sends.

## Migration and archive decision

The first migration creates a separate fresh Qbit keyring in the same
encrypted vault only after the standard generated-seed backup and
word-confirmation flow. The keyring service also requires the submitted seed to
match that locally generated, transiently encrypted value; an imported mnemonic
cannot be labeled clean. A later migration on another network reuses that same
destination wallet instead of minting another seed: the recorded destination is
re-located by its anchor identity (the index-0 account, re-derived under the
recorded network's coin type when the active chain differs) and verified to be
a healthy non-restored wallet before anything is recorded. Only when that
destination no longer resolves does the flow fall back to creating a fresh
seed. The source stays selected while the user reviews the destination mapping,
aggregate amount, fees, and archival consequence.

Each funded recovered account receives a replaceable sweep plan for the
economically spendable subset of its UTXOs because P2MR signing is bound to one
source pubkey. Sweeps stay per-account: each funded source account pays its own
destination account, never a shared address. A common destination would
publicly link every source account, while per-account destinations remove that
linkage at zero fee cost (the flow already builds one send-all transaction per
source account either way). Destination indexes are allocated contiguously from
zero rather than copied from the source: only funded accounts produce plans, so
source *history* can reach an index far beyond the last funded predecessor, and
copying it would leave the destination's funded indexes sparse — a standard
gap-limit restore of the fresh seed would stop scanning before reaching them.
Each plan records its source→destination pairing, a source account that sweeps
again keeps the destination account an earlier plan paired, and indexes the
destination's receive ledger already handed out or already carrying on-chain
activity are skipped so a sweep never reuses a presented receive address. The
skip is bounded by discoverability: handed-out-but-unfunded intents leave no
on-chain trace for a restore scan to extend past, so allocation only skips
while the sweep's landing index stays within the trailing gap a standard
restore scans beyond the funded set (observed activity plus every planned
sweep, all of which confirm before a migration completes). When a full gap of
unfunded receive intents would push the sweep past that window, the oldest
such index is funded instead — reusing a presented address costs single-use
hygiene once, while an undiscoverable sweep forfeits the funds in every later
seed-only restore of the fresh seed. The destination indexes a sweep will pay
are activated in the destination wallet up front, and their receive-ledger
reservations persist in the same vault write as the plans that pay them — a
reservation surviving a failure between two separate writes would durably burn
indexes no plan references. The receive flow still never hands one of them
out: the combined commit holds the receive-intent lock and refuses freshly
allocated indexes the ledger acquired while plans were being built, so a
failed preparation retries against the fresh ledger; at signing time the
plan's pay-to address must match the destination keyring's own derivation at
the recorded index. Plans persisted by earlier
versions that consolidated into the destination anchor stay valid and are never
rewritten — signed bytes are immutable — so a mixed plan set within one
migration is expected. The selector maximizes the destination amount at the
reviewed fee rate; inputs whose value cannot pay their incremental witness cost
are left behind. Plans are persisted before preflight. After signing, the
finalized PSBT and transaction ID are persisted before the UI can proceed.
Resume logic rebroadcasts the same signed bytes, advances only sequential
lifecycle transitions, and keeps both keyrings available after interruption or
failure.

The repository-aligned safe point is confirmation of every plan followed by
a rescan showing no protected assets and no balance capable of producing a
standard destination output at the one-sat/vB relay floor. Uneconomic dust
stays in the retained source rather than aborting other account sweeps. A later
deposit that makes that balance sweepable reopens migration. At the safe point
the fresh destination becomes active and the recovered keyring is marked
`migrated` for that network; the archived card then points at any sibling
networks the seed may still hold funds on, and one network's archive is never
gated on another network's reachability. Deletion was deliberately rejected:
retaining the encrypted source preserves recovery information and allows the
wallet to detect a reorg or newly spendable funds. Either event reopens that
network's migration, while ordinary sends, fee bumps, dApp PSBTs, and message
signing remain blocked for the archived source on its network.

Outputs that cannot be proven to be plain P2MR value outputs are not swept
automatically. Migration stops and requires those outputs to be handled
separately through an explicitly reviewed transaction rather than silently
mixing them into a full-balance transfer.
