# Public explorer fixture validation

Issue #31's optional explorer action is fail-closed: the wallet only renders a transaction link when the configured chain metadata produces a validated URL. A pinned public fixture provides reproducible evidence that the configured Qbit Testnet4 API and explorer route agree, without making ordinary CI depend on a live service.

The fixture does not hardcode an explorer route. It imports the built `@qbit/wallet-shared` package and derives its explorer URL from the production configuration — `getExplorerUrl(CHAINS_MAP[ChainType.QBIT_TESTNET4], 'tx', txid)` — which is the same code path that produces the wallet's "View on block explorer" destination. The API base is likewise read from the chain's configured `endpoints`. If the production configuration cannot produce an explorer URL, the fixture fails at initialization.

## Fixture

| Field                    | Value                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Network                  | Qbit Testnet4                                                                                                         |
| Transaction ID           | `1c55c394c54e9a8925eaa46da2c474f7ea0f3fde2c4293b9058dcece8ef0eb58`                                                    |
| API base                 | `https://mempool-testnet.qbit.org/api`                                                                     |
| API transaction URL      | `https://mempool-testnet.qbit.org/api/tx/1c55c394c54e9a8925eaa46da2c474f7ea0f3fde2c4293b9058dcece8ef0eb58` |
| Explorer transaction URL | `https://mempool-testnet.qbit.org/tx/1c55c394c54e9a8925eaa46da2c474f7ea0f3fde2c4293b9058dcece8ef0eb58`     |

The explorer transaction URL above is the production-generated value. `scripts/conformance/public-explorer-fixture.test.mjs` asserts offline that the fixture URL exactly equals what `getExplorerUrl` produces from `CHAINS_MAP[ChainType.QBIT_TESTNET4]`, so the fixture cannot drift from the wallet's actual route. Running the fixture requires the built workspace packages (`corepack pnpm --filter "@qbit/wallet-shared..." build`).

## Opt-in live check

Run:

```sh
corepack pnpm test:integration:public-explorer
```

The script performs read-only GET requests. It requires the API payload to return the exact pinned txid, a confirmed integer block height, and nonempty witness data. It then requires the production-generated explorer transaction page to return a successful, nonempty response. Any malformed payload, missing witness, HTTP failure, or empty explorer page exits nonzero.

This command is intentionally opt-in and is not part of the ordinary CI test suite. Its validation logic has network-free unit coverage in `scripts/conformance/public-explorer-fixture.test.mjs`.

## Recorded result

On 2026-07-28 the command completed successfully against the previous deployment (`qbitmempooltestnet.robertclarke.com`): the API returned HTTP 200 for the exact txid, confirmed at block 57000 with witness data present, and the explorer page then checked returned HTTP 200 with a nonempty body. That run carries two caveats: the fixture revision it exercised validated a hardcoded explorer URL rather than the production-generated route (corrected in `75731d01`), and it predates the move to `mempool-testnet.qbit.org` — it does not validate the current deployment.

On 2026-08-10 the command was re-run against the then-current path-based Testnet4 deployment and failed: its API route returned the explorer web app's HTML shell (HTTP 200, `text/html`) instead of Esplora JSON. That result predates and does not validate the current `mempool-testnet.qbit.org` deployment. Until the opt-in command succeeds against the current host, the configured Qbit Testnet4 endpoints remain live-unvalidated; the offline consistency check in `scripts/conformance/public-explorer-fixture.test.mjs` is unaffected and keeps the fixture pinned to the wallet's actual route.
