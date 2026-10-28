# qbit Fee Policy

This document defines the wallet policy for qbit fee recommendations, quote
freshness, exact P2MR fee previews, and dust handling. UI amounts use the
product term **bits**; provider and transaction arithmetic use the equivalent
base-unit rate in satoshis per virtual byte (`sat/vB`).

## Provider targets

qbit targets one block per minute, so a target of `N` blocks is presented as
approximately `N` minutes and `N` blocks. The wallet uses the active chain's
configured API surface:

| API surface  |      Slow |   Normal |     Fast | Evidence                                                                                                                                                                                                                                                                                                                            |
| ------------ | --------: | -------: | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Esplora      | 20 blocks | 6 blocks | 2 blocks | Esplora's [`/fee-estimates`](https://github.com/Blockstream/esplora/blob/master/API.md#fee-estimates) response is keyed by confirmation targets. It provides targets 1–25 plus 144, 504, and 1,008, so the issue's 20/6/2 policy is directly representable.                                                                         |
| mempool-qbit |  3 blocks | 2 blocks |  1 block | The pinned [`@qbit-oss/api` adapter](https://github.com/Qbit-Org/qbit-js/blob/2f4637f08be83d4d47ddb6d79eb384d61fccecfb/packages/api/src/index.ts#L1698-L1712) maps `fastestFee`, `halfHourFee`, and `hourFee` to projected blocks 1, 2, and 3. Its `economyFee` and `minimumFee` fields are policy floors, not confirmation estimates. |

The mempool-qbit names are inherited from its provider response shape; they do
not define half-hour or hour targets on qbit. The wallet deliberately
uses the provider's three honest projected-block buckets instead of inventing
20- or 6-block estimates that the surface does not provide.

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
- normalizes positive sub-relay rates to 1 bit/vB; and
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
- Empty or invalid data deletes the entry and returns the 1 bit/vB static
  fallback with an `empty` or `invalid` reason.
- A refresh failure deletes the entry and returns the same fallback with a
  `stale` reason when an expired entry existed, or `unavailable` otherwise.

Fallback tiers retain their target labels but are explicitly marked
`availability: unavailable` and `freshness: fallback`. The UI displays an
unavailable-estimates notice rather than presenting the relay floor as a live
recommendation. Expired values are never used to calculate a send.

## Floor, ceiling, and exact total

The shared qbit policy range is **1 through 10,000 bits/vB**, inclusive.
Provider rates above the ceiling invalidate the entire quote and trigger the
static floor fallback. Programmatic requests outside the range are rejected.
A custom value above the ceiling remains visible so it is not silently
rewritten, but the create screen blocks the send and does not display a
clamped expected fee.

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

## Dust boundary

The P2MR output dust boundary remains **2,855 bits**:

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
confirmation behavior. The across-a-day operational acceptance check therefore
remains a manual/nightly funded-wallet procedure:

1. Use a disposable Testnet4 wallet containing no mainnet key material. Record
   the extension commit, endpoint, UTC time, tip height, and raw recommended-fee
   response:

   ```sh
   TESTNET4_API=https://mempool-testnet.qbit.org/api
   date -u '+%Y-%m-%dT%H:%M:%SZ'
   curl --fail --silent --show-error \
     "$TESTNET4_API/v1/fees/recommended"
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
