/**
 * Reviewed parameters for the optional local Qbit regtest connection.
 *
 * The extension may talk to a developer-run electrs-qbit indexer on the
 * loopback interface. The origin is fixed: the store manifest declares it as
 * an optional host permission and the background verifies the service before
 * any wallet request is routed to it.
 */

/** Exact loopback origin of the local electrs-qbit HTTP API. */
export const QBIT_REGTEST_ORIGIN = 'http://127.0.0.1:3002'

/** Chrome host-permission match pattern for {@link QBIT_REGTEST_ORIGIN}. */
export const QBIT_REGTEST_HOST_PERMISSION = `${QBIT_REGTEST_ORIGIN}/*`

/**
 * Hash of the Qbit regtest genesis block (RPC display byte order).
 *
 * Source: `Qbit-Org/qbit`, `src/kernel/chainparams.cpp`, `CRegTestParams`
 * (`assert(consensus.hashGenesisBlock == uint256{...})`) at commit
 * 7ebcddb622d6e639041f005a189b048ec2a221fe, the signed v1.0.0 release the
 * wallet is conformance-pinned to (`scripts/conformance/core-pin.json`).
 * Qbit's regtest genesis differs from other chain families' regtest genesis
 * blocks, so an indexer for a different chain on the same port cannot satisfy
 * this check.
 */
export const QBIT_REGTEST_GENESIS_HASH =
  '0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6'

/**
 * Read-only Esplora route returning the height-zero block hash as
 * `text/plain`. Exposed by the pinned `Qbit-Org/qbit-electrs` harness
 * (`src/rest.rs`, `GET /block-height/:height`, commit
 * 5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2).
 */
export const QBIT_REGTEST_IDENTITY_ROUTE = '/block-height/0'

/**
 * Read-only route the wallet already depends on (tip height as `text/plain`).
 * Probed alongside the identity route so an identity-only stub is not
 * mistaken for a usable indexer.
 */
export const QBIT_REGTEST_TIP_HEIGHT_ROUTE = '/blocks/tip/height'

/**
 * Version tag of the in-app explanation the user must acknowledge before the
 * wallet requests the optional loopback permission. Bump when the wording or
 * the disclosed data flow changes so existing users see the explanation again.
 */
export const REGTEST_ACCESS_ACK_VERSION = 'regtest_access_ack_v1'
