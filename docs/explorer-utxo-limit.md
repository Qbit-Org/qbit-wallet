# Explorer UTXO listing limit

The wallet reads an address's spendable outputs from the explorer's
`/address/:address/utxo` route. electrs-qbit, behind both Esplora and
mempool-qbit, refuses that route for an address holding more confirmed unspent
outputs than its `--utxos-limit` setting (500 unless configured otherwise).
mempool-qbit relays the refusal as a bare HTTP 500, while `/address/:address`
statistics and the history routes keep answering. Each P2MR account is a single
address, so a solo miner or a pool payout address crosses the limit quickly.

`--utxos-limit` is an explorer deployment setting, outside this repository. The
wallet does not read it; it assumes the electrs default.

## What the wallet assumes

`QBIT_EXPLORER_DEFAULT_UTXO_LIMIT` (500, in
`packages/wallet-background/src/utils/qbit-api.ts`) is the limit the wallet
assumes. A failed listing counts as over the limit only when both of these hold:

- the listing request itself answered HTTP 500, and
- the address statistics show more than 500 *confirmed* unspent outputs
  (`chain_stats.funded_txo_count - chain_stats.spent_txo_count`). electrs counts
  the confirmed set before it applies the mempool, so pending spends do not bring
  an address back under the limit until they confirm.

Every other failure, including a 500 for an address at or under 500 outputs,
keeps its own meaning, so an outage is never shown as this state.

## What happens above the limit

- **Balance.** The balance card shows the total from the address statistics and
  labels it as such. Its Available and Unavailable rows show `--`, with a line
  saying both are unknown because the explorer does not list the outputs: the
  wallet cannot classify outputs it has not read, and the balance poll never
  reads them from history. The balance reports
  `availableBalance`, `immatureBalance` and `pendingBalance` as `null`
  (unknown, not 0), and keeps `unavailableBalance` equal to the total.
- **Sending.** The send screen reads the account's outputs from its complete
  history instead (`getQbitAddressUtxosClassifiedFromHistory`). That read fails
  closed. The statistics must match before and after the walk, the walk must
  hold exactly their transaction counts, and the outputs it finds funded and
  spent must reconcile with their counts and sums. A history that moved or does
  not reconcile is retried a bounded number of times and then reported as
  unknown, never as a smaller balance. Histories longer than
  `QBIT_UTXO_HISTORY_MAX_TRANSACTIONS` (10,000 transactions), or longer than the
  client's page ceiling, are not read: the outputs stay unknown and the send
  screen points to consolidation. So is an address with more pending
  transactions than an Esplora `/txs/mempool` response lists (50). The
  production mempool-qbit route pages its mempool rows instead.
- **Consolidation.** The account can sweep its outputs to its own address one
  batch at a time. Each batch carries the largest mature confirmed outputs, at
  most 106, the limit that keeps it within the 400,000 WU standard weight. The
  inputs come from a newest-first walk of the history that resumes where the
  previous batch stopped, with a bounded page budget per batch. They are never
  taken from a balance. Every input is checked unspent at
  `/tx/:txid/outspends` when the batch is built. When the wallet signs the
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
- **Restored wallets.** Rebuilding a restored wallet's signature-counter
  floors reads no outputs. An address whose history is too long to read in
  full takes its floor from its statistics instead, so a restored account
  over either limit can lift its signing gate and then consolidate. See
  [PQC Signature Counter Lifecycle](pqc-counter-lifecycle.md#restore-safety).
- **Recovery migration.** Preparing a migration reads an over-limit source
  account's outputs from its history as the send screen does, and the usual
  batching splits them into plans of at most 106 inputs. A source whose history
  exceeds the read limit cannot be planned. Preparation skips it, plans the
  other sources, and names it on the migration screen. Its funds keep the
  migration open, so it is never archived with them, and a check of an
  archived wallet that finds one reopens its migration. While a migration is
  open, the recovered wallet signs nothing but its reviewed plans, with one
  exception for such a source. Its consolidation batches can be signed, but
  only while none of its plans is open. The keyring checks that each batch
  pays everything it spends back to the same address, less a fee no higher
  than the wallet's highest fee rate allows. Once consolidation
  brings the source within the listing limit, the next preparation lists its
  outputs and plans them. Consolidating before starting recovery works too.

## Limits consolidation cannot lift

- An address that keeps receiving more than about 500 coinbase outputs per
  1,000-block maturity window stays over the limit. Immature outputs cannot be
  spent, and they still count against it.
- Outputs worth no more than the fee their input adds would cost more to
  consolidate than they carry. Batches leave them out at the chosen fee rate,
  and the walk reads past them to older, larger outputs.
- Each batch removes at most 105 outputs, since its 106 inputs become one
  output. An address tens of thousands of outputs over the limit would need
  hundreds of signed batches.

For such accounts the explorer operator has to raise `--utxos-limit`. If the
production limit is raised above 500, `QBIT_EXPLORER_DEFAULT_UTXO_LIMIT` keeps
working: an address under the new limit lists normally and never reaches this
path. Lowering the limit below 500 would make listing failures for addresses
between the two values look like ordinary outages.
