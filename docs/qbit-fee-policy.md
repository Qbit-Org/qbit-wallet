# qbit Fee Policy

This document defines the wallet policy for qbit fee recommendations, quote
freshness, exact P2MR fee previews, and dust handling. UI amounts use the
product term **bits**; provider and transaction arithmetic use the equivalent
base-unit rate in satoshis per virtual byte (`sat/vB`).

## Provider targets

qbit targets one block per minute, so a target of `N` blocks is presented as
approximately `N` minutes and `N` blocks. The wallet uses the active chain's
configured API surface:

| API surface  |      Slow |   Normal |     Fast | Evidence                                                                                                                                                                                                                                                                                                                                           |
| ------------ | --------: | -------: | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Esplora      | 20 blocks | 6 blocks | 2 blocks | Esplora's [`/fee-estimates`](https://github.com/Blockstream/esplora/blob/master/API.md#fee-estimates) response is keyed by confirmation targets. It provides targets 1–25 plus 144, 504, and 1,008, so the issue's 20/6/2 policy is directly representable.                                                                                        |
| mempool-qbit |  3 blocks | 2 blocks |  1 block | The wallet reads the explorer's [`/fees/precise`](https://github.com/Qbit-Org/qbit-explorer/blob/70f469f51ee9a854f24f6bdf77bf4b1dc52929b1/backend/src/api/fee-api.ts#L34-L50) and takes `fastestFee`, `halfHourFee`, and `hourFee` as targets 1, 2, and 3. Its `economyFee` and `minimumFee` fields are policy floors, not confirmation estimates. |

The mempool-qbit names are inherited from its provider response shape; they do
not define half-hour or hour targets on qbit. The wallet deliberately
uses the provider's three honest projected-block buckets instead of inventing
20- or 6-block estimates that the surface does not provide.

When the precise read fails or gives no usable quote, the wallet falls back to
`/fees/recommended` through the pinned
[`@qbit-oss/api` adapter](https://github.com/Qbit-Org/qbit-js/blob/1cbf4b3e8fd3c7e51eba0d953910d5dafc9ae88f/packages/api/src/adapters.ts#L149-L163),
which maps the same three fields to the same targets. Both routes are
requested under the chain's API base (`https://mempool.qbit.org/api` on
mainnet); the explorer serves them under `/api/v1` as well.

The precise read is sent once and has 5 seconds to answer. After it fails, or
gives no usable quote, the wallet reads the whole-number tiers directly for
10 minutes before it tries the precise route again, so a missing, throttled
or hung route costs neither a wait nor a second request on every refresh.

The explorer gives precise rates in thousandths of a bit/vB. It never quotes
`fastestFee` below 1 or `halfHourFee` below 0.5 bits/vB, and no tier below the
node's mempool minimum (`mempoolminfee`, rounded up to a thousandth), so an
empty mempool reads as 1, 0.5, and 0.25 bits/vB for the three targets.
`/fees/recommended` rounds the same tiers to whole numbers of at least
1 bit/vB, so a quote read through that fallback offers no tier below 1.

For a missing exact bucket, the wallet chooses the available target closest to
the desired target without being slower. If any tier has no estimate at least
that fast, the response is invalid and the wallet uses the explicit unavailable
fallback. The displayed minutes/blocks remain the wallet's requested tier
target, while every selected live rate is conservative for that window.

Provider responses are untrusted monetary input. The wallet:

- requires a non-empty array of unique, safe-integer targets from 1 through
  1,008;
- requires finite, positive rates no greater than 10,000 bits/vB;
- sorts targets and rejects rates that increase for a slower confirmation
  target;
- raises a positive rate below the 0.25 bits/vB relay floor to 0.25;
- rounds every rate up to two decimal places (0.01 bits/vB, the resolution
  of the Custom rate input), so a precise 0.333 is offered as 0.34; and
- resolves empty or invalid responses to the unavailable fallback below.

Quote-less `FeeSummary` responses do not carry qbit quote metadata and retain
their existing behavior.

## Freshness and fallback

A live quote is cached in memory for **60,000 ms**, one expected qbit block.
Cache keys include the exact chain, API surface, and endpoint. Mainnet,
Testnet4, regtest, and differently configured endpoints therefore cannot share
a quote.

- Age `0 <= age < 60,000 ms`: a fresh cached quote may be reused and is marked
  `freshness: cached`, retaining its original `fetchedAt`.
- Age exactly 60,000 ms or greater, or a clock moving backwards: refresh is
  required.
- A successful refresh replaces the exact cache entry and is marked
  `freshness: live`.
- Empty or invalid data deletes the entry and returns the static fallback,
  every tier at 1 bit/vB (`QBIT_FALLBACK_FEE_RATE`), with an `empty` or
  `invalid` reason.
- A refresh failure deletes the entry and returns the same fallback with a
  `stale` reason when an expired entry existed, or `unavailable` otherwise.

Fallback tiers retain their target labels but are explicitly marked
`availability: unavailable` and `freshness: fallback`. The UI displays an
unavailable-estimates notice with the rate in use rather than presenting the
fallback as a live recommendation. Expired values are never used to calculate
a send.

The fallback rate is not the relay floor. Without an estimate the wallet
cannot see that the mempool's minimum has risen above the 0.25 bits/vB floor,
and a send at the floor could then stay unconfirmed, so it uses 1 bit/vB. A
Custom rate can still go down to 0.25 bits/vB while estimates are unavailable.

## Floor, ceiling, and exact total

The shared qbit policy range is **0.25 through 10,000 bits/vB**, inclusive
(`QBIT_MIN_RELAY_FEE_RATE` and `QBIT_MAX_FEE_RATE`). Provider rates above the
ceiling invalidate the entire quote and trigger the static fallback.
Programmatic requests outside the range, including a website's `feeRate`, are
rejected. A Custom rate below the floor stays as typed, keeps Next disabled,
and the send and consolidation screens name the minimum. A custom value above
the ceiling remains visible so it is not silently rewritten, but the create
screen blocks the send and does not display a clamped expected fee.

The floor is qbit Core's relay floor, `DEFAULT_MIN_RELAY_TX_FEE{250}` sat/kvB in
[`src/policy/policy.h`](https://github.com/Qbit-Org/qbit/blob/7ebcddb622d6e639041f005a189b048ec2a221fe/src/policy/policy.h#L73)
at the pinned v1.0.0, with `DEFAULT_INCREMENTAL_RELAY_FEE{250}` beside it:
0.25 bits/vB is both the lowest rate the node relays and the least a
replacement must add per vbyte of its size. The node rounds the fee it
requires up (`CFeeRate::GetFee` evaluates it with `EvaluateFeeUp`), and so
does the wallet, so a fee at exactly the floor is relayed: a one-input,
one-output send of 3,817 vbytes pays 955 bits, 954.25 rounded up. The live
`tx-fees` conformance row checks that the node's `minrelaytxfee` and
`incrementalrelayfee` are the wallet's floor, and that the node accepts that
fee and refuses one bit less.

For a valid rate, the P2MR estimator is the single source of truth:

```text
estimated fee = ceil(exact finalized vsize × selected rate)
maximum total fee = exact finalized vsize × 10,000 bits/vB
```

Both results must be safe JavaScript integers. The controller repeats the
policy check immediately before construction. If a no-change transaction
would fold a sub-dust remainder into the paid fee, the controller also rejects
the transaction when that resulting total exceeds the exact size-based
maximum, even when the selected rate itself equals the ceiling.

The preview's exact paid fee is the selected inputs minus all outputs. It is
verified against the constructed PSBT and finalized raw transaction, not
recomputed with React-side size constants. The UI reports any folded remainder
separately so it is not mistaken for the rate-derived portion.

P2MR inputs are considered fee-dominant when their exact base bytes plus
witness-stack bytes are at least **75%** of the finalized transaction size.
The create screen shows a localized explanation when this threshold is met.

## Fee bump and recovery migration

Both keep a 1 bit/vB rule of their own on purpose:

- A fee bump (Speed up) targets at least the original rate rounded down plus
  1 bit/vB, and raises the fee by at least 1 bit per vbyte of the
  replacement. qbit Core asks a replacement to add only its incremental relay
  fee, 0.25 bits/vB (`DEFAULT_INCREMENTAL_RELAY_FEE{250}` sat/kvB) of the
  replacement's size, so a step above it is always valid. A transaction sent
  at 0.25 bits/vB bumps to at least 1 bit/vB.
- A recovery migration prices a new plan at the live normal rate but never
  below 1 bit/vB (`QBIT_RECOVERY_MIGRATION_RELAY_FEE_RATE`), the rate it also
  uses without an estimate. Its plans are signed once and afterwards only
  rebroadcast byte for byte, and a migrating wallet cannot bump them, so a
  plan priced at the floor could stay unmined whenever the rate that clears
  the mempool rises. The migration's safe point measures what is still worth
  sweeping at the same rate (see
  [Seed-only restored wallet safety](seed-only-restored-wallet-safety.md)).

Not every transaction can be bumped. A bump takes its added fee from the
change output, so a send of the whole balance, which has none, and a
consolidation batch, which pays a single output back to the wallet, are sent
at the selected rate and wait for it. Both accept rates from 0.25 bits/vB,
and a live Normal tier can be below 1 bit/vB. If the mempool's minimum rises
above the rate such a transaction pays, the node drops it, the wallet
releases its inputs, and it can be sent again at a higher rate.

Wherever the wallet shows a rate worked out from a fee and a size (an
approval, a fee bump, a history entry), it rounds the rate down to hundredths,
so a rate shown is never higher than the rate paid: 936 bits for 3,817 vbytes
shows as 0.24 bits/vB, below the floor, not 0.25.

## Abnormal-fee warnings

The 10,000 bits/vB ceiling only stops mistakes no one would make by hand, so
the wallet also flags fees that are allowed but abnormal. The send screen
checks its exact preview, and every PSBT approval (wallet sends, fee bumps,
website requests) checks the exact PSBT it will sign. A fee is abnormal when
any of these holds (`assessQbitFee`, constants in
`packages/wallet-shared/src/utils/qbit-fee-warnings.ts`):

| Reason                   | Condition                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `above_recommended_rate` | The rate is at least **10×** the fastest live recommended tier, also one below 1 bit/vB: a recommendation of 0.5 bits/vB flags 5 bits/vB.                                             |
| `above_relay_floor`      | The rate is at least **100 bits/vB**, whatever the explorer recommends.                                                                                                               |
| `large_share_of_amount`  | The fee is at least **25%** of what the transaction pays to others, at a rate at least **2×** the recommended rate, or 2× 1 bit/vB when the recommendation is lower or there is none. |

The 100 bits/vB bound (`QBIT_FEE_WARNING_RATE_BOUND`) is a fixed number, 400×
the 0.25 bits/vB relay floor. It no longer moves with the floor, so it flags
exactly the rates it flagged when the floor was 1 bit/vB, and the reason
keeps its name, `above_relay_floor`. The bound does not depend on the
explorer, so a glitched or hostile quote cannot hide an overpayment.

The share check needs the rate to be at least twice the recommendation
because a small payment at the recommended rate legitimately costs a large
share of itself, and a sub-dust remainder folded into its fee lifts a
one-input send to at most about 1.75× that rate. That remainder is a fixed
amount, at most 2,854 bits, which adds up to about 0.75 bits/vB to a
one-input send at any rate: at most 1.75× the rate from 1 bit/vB up, but
about 4× at 0.25 bits/vB. The share check therefore never measures against
less than the 1 bit/vB fallback rate (`QBIT_FALLBACK_FEE_RATE`), which also
stands in when there is no live recommendation. A transfer that pays only the
wallet has no amount to compare with.

A website-supplied PSBT gets one more share check, because the wallet cannot
always size it (`checkFeeShareWithoutSize`). `large_share_of_amount` also
applies to it at any rate when the fee is at least 25% of what the
transaction pays to others and at least twice what the smallest send costs
at the rate the share check measures against (the recommendation, never less
than 1 bit/vB and never more than the 100 bits/vB bound). The approval then
shows a high fee at a normal rate (`highFeeAtNormalRate`).

Only a live quote counts as a recommendation. With the fallback quote offered
without estimates, or no quote at all, the wallet applies the bounds that
need none, with the share check measuring against the 1 bit/vB fallback, and
says the fee was not compared with recommended rates instead of staying
silent.

The send screen shows the warning and the total leaving the wallet but does
not block Next. An approval with an abnormal fee adds a `HIGH_FEE_RATE` risk,
so signing requires typing the confirmation in the risk review.

## Net spend and unrecognised outputs

Every PSBT approval leads with what leaves the wallet: the inputs spent from
any of the wallet's accounts less the outputs paid back to them, fee
included. The wallet's accounts are those that can sign, by the wallet or an
external or cold signer; a watch-only address belongs to someone else. The
send screen counts a payment to one of them the same way, so only the fee
leaves. When every input is the wallet's own, it is split into what goes
to others and the network fee. An input without its spent output makes the
amount unknown, and the approval says so rather than showing a partial sum.

An output that pays neither one of the wallet's accounts nor a recipient the
request names (the wallet's own send, fee bump and migration requests name
theirs) is marked unrecognised. When the request names a recipient, or the
output's script has no address, it also adds an `UNRECOGNISED_OUTPUT` risk.
Pay-to-anchor outputs that carry no more than `QBIT_P2A_MAX_VALUE` (330)
together are fee anchors instead: they add no risk of that kind, but their
value counts as paid to others, so the fee is compared with it.

The background computes this summary from the exact PSBT bytes under review
(`decodePsbt`) for the current account. It refuses to publish a summary when
the account changes while it reads the quote, and the approval discards a
summary computed for an account other than the current one.

## Dust boundary

The P2MR output dust boundary remains **2,855 bits**. It derives from qbit
Core's dust relay fee, `DUST_RELAY_TX_FEE{750}` sat/kvB, not from the relay
floor, so the 0.25 bits/vB floor leaves it unchanged:

- recipient amounts below 2,855 bits are rejected;
- exactly 2,855 bits is accepted;
- change of at least 2,855 bits is returned as a P2MR output; and
- a smaller positive remainder is folded into the exact paid fee and disclosed
  separately.

Coin selection, preview, construction, and finalized-size regression tests use
the same estimator for change, no-change, memo, multi-input, and send-all
transactions.

## Testnet4 operational spot-check

Read-only inspection at `2026-07-28T19:53:08Z` returned tip height `57447` and
the following active Testnet4 mempool-qbit quote:

```json
{ "fastestFee": 1, "halfHourFee": 1, "hourFee": 1, "economyFee": 1, "minimumFee": 1 }
```

No transaction was broadcast and no Testnet4 funds were used. The response
confirmed the live response shape, but equal rates cannot prove tier-specific
confirmation behavior.

A read-only read of `/v1/fees/precise` on 2026-11-11 returned the same quote
on mainnet and Testnet4:

```json
{ "fastestFee": 1, "halfHourFee": 0.5, "hourFee": 0.25, "economyFee": 0.25, "minimumFee": 0.25 }
```

No transaction was broadcast. These are the explorer's floors for an empty
mempool, so they confirm the precise response shape and the 0.25 bits/vB
minimum, but not tier-specific confirmation behavior either. The across-a-day
operational acceptance check therefore remains a manual/nightly funded-wallet
procedure:

1. Use a disposable Testnet4 wallet containing no mainnet key material. Record
   the extension commit, endpoint, UTC time, tip height, and raw precise-fee
   response:

   ```sh
   TESTNET4_API=https://mempool-testnet.qbit.org/api
   date -u '+%Y-%m-%dT%H:%M:%SZ'
   curl --fail --silent --show-error \
     "$TESTNET4_API/v1/fees/precise"
   curl --fail --silent --show-error \
     "$TESTNET4_API/blocks/tip/height"
   ```

2. At multiple points spanning at least 24 hours, prepare one Slow, Normal, and
   Fast send. Before approval, record the selected tier and rate, predicted
   vsize, exact expected paid fee, input count, folded remainder, and whether
   the input-dominance hint appears. Cancel if the wallet shows the fallback
   notice; a fallback is not live tier evidence.
3. Only with explicit authorization for that run, broadcast the small sends
   from the disposable funded wallet. Never put a mnemonic, private key, or
   signing material in logs or CI secrets. Record only each txid, submission
   UTC time, submission tip, tier target, and the non-secret preview fields.
4. Poll each transaction's status and the tip endpoint until confirmed. Record
   confirmation height/time and calculate `confirmation height - submission tip`.
   Treat reorged transactions as unconfirmed until reconfirmed.
5. Compare observed blocks with the 3/2/1 mempool-qbit targets (or 20/6/2 when
   explicitly testing an Esplora-configured build). Report every sample,
   including misses; do not infer tier performance when all three quoted rates
   are equal.
6. Re-run the exact-size/dust regression suites and attach the commit, raw
   quote samples, and result table to the acceptance record. A nightly job may
   automate read-only sampling and status polling, but transaction signing and
   funding must remain in an explicitly authorized protected environment.
