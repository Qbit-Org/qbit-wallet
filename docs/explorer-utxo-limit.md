# Explorer UTXO listing limit

The wallet reads an address's spendable outputs from the explorer's
`/address/:address/utxo` route. qbit-electrs, behind both Esplora and
mempool-qbit, refuses that route for an address whose confirmed unspent outputs
pass its `--utxos-limit` setting (500 unless configured otherwise), with HTTP
400 and the reason `Too many unspent transaction outputs (>N). Contact support
to raise limits`. mempool-qbit since v1.0.0 relays that reason with HTTP 413 (as
`{"error":"..."}` to a client that accepts JSON); before that it answered a
bare HTTP 500. The `/address/:address` statistics and the history routes keep
answering. Each P2MR account is a single address, so a solo miner or a pool
payout address crosses the limit quickly.

`--utxos-limit` is an explorer deployment setting, outside this repository. On
2026-11-06 the production explorers raised it from 500 to 50,000 on mainnet
and testnet4, so every mainnet address lists in one call again (the largest
held 9,772 outputs); two testnet4 addresses hold about 110,000.

electrs refuses an address whose output set passed the limit **at any point**
since it last cached that set, not only one that holds more outputs now: it
rebuilds the set from that cache one history row at a time, and gives up as
soon as the set it is building passes the limit, so it never caches a newer one
(`utxo_delta` in `src/new_index/schema.rs`, Qbit-Org/qbit-electrs@53102e9). An
address that passed the limit therefore stays refused after it consolidates
below it, until the operator raises the limit past the most it held.

## How the wallet recognizes the limit

A failed listing counts as the explorer's limit (`qbitUtxoListRefusal` and
`isQbitUtxoListOverExplorerLimit`, in
`packages/wallet-background/src/utils/qbit-api.ts`) when the listing request
itself, and not one of the per-output lookups that follow it, answered either:

- with electrs' reason, `Too many unspent transaction outputs`, at any status
  (400 from electrs itself, 413 from mempool-qbit), or with HTTP 413. The
  explorer states this refusal, so it counts whatever the address's statistics
  show, and the limit is the `N` its message states, when it states one; or
- with a bare HTTP 500, as mempool-qbit before v1.0.0 answered every failure
  of the route, for an address whose statistics show more than 500
  *confirmed* unspent outputs (`chain_stats.funded_txo_count -
  chain_stats.spent_txo_count`), the electrs default the wallet assumes for
  such an explorer (`QBIT_EXPLORER_DEFAULT_UTXO_LIMIT`). electrs counts the
  confirmed set before it applies the mempool, so pending spends do not bring
  an address back under the limit until they confirm.

Every other failure, including a bare 500 for an address at or under 500
outputs, keeps its own meaning. Nothing in a bare 500 says which explorer
answered, though. One for an address over 500 outputs counts as the limit
even from an explorer that states its refusals, where it can only be an
outage, and an older explorer's bare 500 for an address electrs refuses with
fewer outputs than that cannot be told from an outage.

A 413 is final, so the client does not retry it; a bare 500 is retried as any
other transient reply first.

## What happens above the limit

- **Balance.** The balance card shows the total from the address statistics and
  labels it as such. The balance poll never reads outputs from history, so the
  split between Available and Unavailable comes from the latest output read
  from the address's history on that network (the send screen's read,
  `getQbitUtxoSnapshot`), and only while that read applies: while the address
  statistics read as they did when its walk verified them, so any new
  transaction for the address ends it, and while no coinbase output it left
  out or took in has matured or turned immature again since. `availableBalance`
  is then what a send may select from those outputs, less the outputs the send
  guard reserves, never more than the total, and `unavailableBalance` is the
  rest. Otherwise the split is unknown, failing closed: with no such read,
  when the statistics the limit check read do not give a balance, when the
  chain tip a read with coinbase outputs needs cannot be read or is not a
  valid height, or when the send guard does not answer within the balance
  read's bounded wait. The Available and Unavailable rows then show `--`, with
  a line saying both are unknown because the explorer does not list the
  outputs, and the balance reports `availableBalance` as `null` (unknown, not
  0) and keeps `unavailableBalance` equal to the total.
  `immatureBalance` and `pendingBalance` stay `null` either way. The wallet
  keeps these reads in memory only, for the four addresses most recently used
  on each network, and forgets them whenever the wallet locks, its data is
  reset or a keyring is removed.
- **Sending.** The send screen reads the account's outputs from its complete
  history instead (`getQbitAddressUtxosClassifiedFromHistory`). That read fails
  closed. The statistics must match before and after the walk, the walk must
  hold exactly their transaction counts, and the outputs it finds funded and
  spent must reconcile with their counts and sums. A history that moved or does
  not reconcile is retried a bounded number of times and then reported as
  unknown, never as a smaller balance. Histories longer than
  `QBIT_UTXO_HISTORY_MAX_TRANSACTIONS` (10,000 transactions), or longer than the
  client's page ceiling, are not read: the outputs stay unknown and the send
  screen says it cannot send from the account. So is an address with more pending
  transactions than an Esplora `/txs/mempool` response lists (50). The
  production mempool-qbit route pages its mempool rows instead. When they
  fill whole pages, the read steps back over the empty page qbit-electrs
  answers after the last of them, as consolidation does (below); the restore
  floor scan, recovery's spender check and activity history read the same
  way. If the pending rows change between that empty page and the one after
  the step back, the read fails closed and is retried. Should every retry
  fail, the outputs stay unknown, and recovery skips the source for that
  pass and names it; the check of an archived migration fails instead and
  reopens nothing.

  A payment that needs more of the account's outputs than one transaction
  carries (106 single-key inputs) is no longer refused. The send screen
  prices it as a send plan from the outputs this read found: transactions
  that combine the account's own confirmed outputs and pay them back to its
  address (merges, at most 106 inputs each), then one payment that spends
  the merges' outputs once they confirm. The user confirms the plan once and
  the wallet signs, sends and watches every transaction (see
  [qbit Fee Policy](qbit-fee-policy.md#send-plans)). The background reads the
  outputs again the same way when it prepares the plan, so a plan runs above
  the listing limit wherever a send can read the account's outputs. Where
  that read fails, as for a history past the read limit, the send screen
  still says it cannot send from the account and offers consolidation, and
  no plan is prepared either.
- **Consolidation.** The account can sweep its outputs to its own address one
  batch at a time, while the explorer refuses to list them. Whether it does is
  the explorer's own answer, asked again for the consolidation screen's status
  and for each batch (`getQbitUtxoListLimit`), never a count: an account it
  lists has nothing to consolidate, whatever its count, and one it still
  refuses can consolidate with fewer outputs than the limit. The status names
  the limit the refusal states, or the 500 assumed for a bare 500, and no
  number of batches: consolidating does not end the refusal (see above), and
  the screen says so when the refusal names a limit or the wallet assumes
  one. Each batch carries the largest mature confirmed outputs, at most 106,
  the limit that keeps it within the 400,000 WU standard weight.
  The wallet relies on the explorer measuring the same size, as it does from
  explorer 1.1.0 (qbit-explorer#58): its broadcast check refuses a
  transaction whose serialized size with witness is over its
  `MAX_PUSH_TX_SIZE_WEIGHT` of 400,000, with code -3 and before any node sees
  it, so a full batch of 106 goes through. Deployments before 1.1.0 counted
  base bytes ×4 plus witness bytes and refused 103 single-key inputs and
  more. There a batch of 103 to 106 inputs reads "not sent", its inputs
  return for the next batch, and a batch of 102 or fewer goes through. The
  user may choose a smaller batch, any whole number of inputs from 2 to 106,
  with 106 the default; a size outside that range is refused before the
  explorer is asked anything. Smaller batches cost a little more in total,
  since each pays for its own output and removes one output fewer than it
  spends: per output removed, about 3% more at 25 inputs and 10% more at 10
  than full batches. An explorer refusal of a batch as too large reads "not
  sent" once the lookups find it absent, and its inputs return for the next
  batch; before, it read "Payment status unknown" and held them for 10
  minutes to 24 hours. The failure screen offers no Retry after that refusal,
  since the explorer refuses the same bytes the same way. The inputs come
  from a newest-first walk of the history that resumes where the previous
  batch stopped, with a bounded page budget per batch; a smaller batch stops
  it sooner. They are never taken from a balance. Every input is checked
  unspent at `/tx/:txid/outspends` when the batch is built. When the wallet
  signs the
  batch itself, the check runs again just before the one-time signatures are
  spent. Inputs a send claim, signing lock or recent broadcast holds stay out,
  so an interrupted run resumes without spending anything twice. The inputs of
  a batch that was never signed come back for the next one. Consolidation needs no full history read, so it also works
  for accounts above the 10,000-transaction read limit. On mempool-qbit the
  walk pages the combined route, pending rows first. qbit-electrs answers a
  cursor that is the last pending row with an empty page instead of the
  confirmed rows after it, so when the pending rows fill whole pages (50
  each) the walk steps back one row and reads on from there. It ends only
  when that page holds the pending row alone.

  A payment no longer needs consolidating first: a send plan makes the
  merges it needs itself (see Sending). Consolidation stays the way to merge
  outputs without paying anyone, and the only one for an account whose
  outputs the send screen cannot read, since it needs no full history read.
- **Restored wallets.** Rebuilding a restored wallet's signature-counter
  floors reads no outputs. An address whose history is too long to read in
  full takes its floor from its statistics instead, so a restored account
  over either limit can lift its signing gate and then consolidate. See
  [PQC Signature Counter Lifecycle](pqc-counter-lifecycle.md#restore-safety).
- **Recovery migration.** Preparing a migration reads an over-limit source
  account's outputs from its history as the send screen does, and the usual
  batching splits them into plans of at most 106 inputs. An explorer before
  1.1.0 refuses a plan of 103 to 106 inputs. The plan stays signed, but the
  pass that sends it ends with that refusal, so the migration does not move
  past it until the explorer measures qbit's size; nothing is lost, and a
  later pass sends it again. A source whose history exceeds the read limit cannot
  be planned. Preparation skips it, plans the other sources, and names it on
  the migration screen. Its funds keep the
  migration open, so it is never archived with them, and a check of an
  archived wallet that finds one reopens its migration. While a migration is
  open, the recovered wallet signs nothing but its reviewed plans, with one
  exception for such a source. Its consolidation batches can be signed, but
  only while none of its plans is open. The keyring checks that each batch
  pays everything it spends back to the same address, less a fee no higher
  than the wallet's highest fee rate allows. Once the explorer lists the
  source again, which takes a limit raised past the most it held, the next
  preparation lists its outputs and plans them.

## Limits consolidation cannot lift

- The refusal itself. electrs keeps refusing an address that once passed its
  limit, so no number of batches makes the explorer list it again; only the
  operator raising `--utxos-limit` past the most the address held does.
  Consolidating still merges outputs, so a send read from history needs
  fewer inputs.
- An address the explorer refuses whose history is also longer than the
  10,000-transaction read limit is past both reads: its outputs can be
  neither listed nor read from history, so the wallet cannot send from it or
  plan it for recovery. Consolidation only adds to that history.
- Outputs worth no more than the fee their input adds would cost more to
  consolidate than they carry. Batches leave them out at the chosen fee rate,
  and the walk reads past them to older, larger outputs.
- Each batch removes at most 105 outputs, since its 106 inputs become one
  output, and fewer at a smaller chosen size. Merging tens of thousands of
  outputs takes hundreds of signed batches.

A raised limit needs no change in the wallet: an address under it lists
normally and never reaches this path, and electrs' message states it. Only an
older explorer's bare 500 leaves the wallet assuming 500, and against such an
explorer configured below 500, listing failures for addresses between the two
values look like ordinary outages.
