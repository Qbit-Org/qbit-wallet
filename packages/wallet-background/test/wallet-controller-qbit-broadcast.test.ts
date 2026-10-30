import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { CHAINS_MAP, KeyringType } from '@qbit/wallet-shared'
import type { QbitBroadcastFailure, QbitSendBroadcastClaim, ToSignData } from '@qbit/wallet-shared'
import { transactionCore } from '@qbit/wallet-core'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  QBIT_RECENT_SPEND_PROBE_INTERVAL_MS,
  QBIT_RECENT_SPEND_TTL_MS,
  QBIT_WALLET_SEND_CLAIM_ORIGIN,
} from '../src/services/qbitSendGuards'
import { QBIT_BROADCAST_ABSENCE_PROBES } from '../src/utils/qbit-broadcast'
import { QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS } from '../src/utils/qbit-explorer-fetch'
import { QBIT_FEE_BUMP_RECHECK_WAIT_MS } from '../src/utils/qbit-fee-bump-recheck'

const broadcastTxMock = vi.hoisted(() => vi.fn())
const getTxMock = vi.hoisted(() => vi.fn())
const getTxStatusMock = vi.hoisted(() => vi.fn())
const getTxHexMock = vi.hoisted(() => vi.fn())
const getTxOutspendsMock = vi.hoisted(() => vi.fn())
const apiClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    broadcastTx: broadcastTxMock,
    getTx: getTxMock,
    getTxHex: getTxHexMock,
    getTxOutspends: getTxOutspendsMock,
    getTxStatus: getTxStatusMock,
  }))
)

vi.mock('@qbit-oss/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@qbit-oss/api')>()
  return {
    ...actual,
    EsploraClient: apiClientMock,
    MempoolQbitClient: apiClientMock,
  }
})

// The send guard is the real service so pre-dispatch refusals (claim
// conflicts, inactive claims) come from production logic, not a stub.
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  const guard = new QbitSendGuardService()
  guard.init()
  return {
    keyringService: {
      keyrings: [],
      signP2mrPsbtWithCounter: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
    },
    qbitSendGuardService: guard,
    walletApiService: { transactionCore: { pushTx: vi.fn(), decodePsbt: vi.fn() } },
    sessionService: {},
    contactBookService: {},
    notificationService: {},
    permissionService: {},
  }
})

vi.mock('../src/services/approval', () => ({ default: {} }))

const ENDPOINT = 'http://127.0.0.1:3002/tx'
const REGTEST_ENDPOINT = CHAINS_MAP[ChainType.QBIT_REGTEST]!.endpoints[0]!
const MAINNET_ENDPOINT = CHAINS_MAP[ChainType.QBIT_MAINNET]!.endpoints[0]!
const SOURCE_TXID = `01${'00'.repeat(31)}`
const HTML_BODY = '<html><body>Bad gateway at http://127.0.0.1:3002</body></html>'
const PROXY_400_BODY =
  '<html><head><title>400 Bad Request</title></head><body>nginx at http://127.0.0.1:8080</body></html>'

function reverseTxid(txid: string) {
  return bytesToHex(new Uint8Array(hexToBytes(txid)).reverse())
}

/** A signed, finalized single-input P2MR transaction, as signPsbtV2 would hand the UI. */
function signedFixture(outputValue = 40_000n) {
  const pubkeyHex = '11'.repeat(32)
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: hexToBytes(reverseTxid(SOURCE_TXID)), vout: 0 },
        witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: outputValue, scriptPubKey: p2mrScriptPubKey(leafHash) }],
  })
  const unsignedPsbtHex = bytesToHex(serializePsbt(psbt))
  const signing = signP2mrPsbt({
    psbt,
    keys: [{ inputIndex: 0, pubkey, leafHash }],
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
  })
  const signed = signing.psbt
  const finalized = finalizeP2mrPsbt(signed)
  const rawTx = extractP2mrTransaction(finalized)
  const rawTxHex = bytesToHex(rawTx)
  return {
    address: p2mrAddressFromPubkey(pubkey, 'regtest'),
    pubkeyHex,
    leafHashHex: bytesToHex(leafHash),
    unsignedPsbtHex,
    /** What the keyring hands back to signPsbtV2 before finalization. */
    signing,
    psbtHex: bytesToHex(serializePsbt(finalized)),
    rawTxHex,
    txid: transactionCore.Transaction.fromBuffer(Buffer.from(rawTx)).getId(),
  }
}

const fixture = signedFixture()
/** Another valid signed transaction over the same input: what a wrong paste or scan hands back. */
const otherFixture = signedFixture(39_000n)

function claimFor(txid = fixture.txid): QbitSendBroadcastClaim {
  return {
    chain: ChainType.QBIT_REGTEST,
    address: fixture.address,
    origin: 'https://dapp.example',
    txid,
    outpoints: [{ txid: SOURCE_TXID, vout: 0 }],
  }
}

function rejection(body: string) {
  return new QbitApiError('http', `HTTP 400 from ${ENDPOINT}: ${body}`, {
    status: 400,
    url: ENDPOINT,
    responseBody: body,
  })
}

function notFound() {
  return new QbitApiError('not_found', `HTTP 404 from ${ENDPOINT}`, { status: 404, url: ENDPOINT })
}

function networkError() {
  return new QbitApiError('network', `network error: ${ENDPOINT} (TypeError: fetch failed)`, {
    url: ENDPOINT,
  })
}

/** Resolve the lifecycle probe as pending (status unconfirmed and body present). */
function probePending() {
  getTxStatusMock.mockResolvedValueOnce({ confirmed: false })
  getTxMock.mockResolvedValueOnce({ txid: fixture.txid })
}

function probeGone() {
  getTxStatusMock.mockRejectedValueOnce(notFound())
}

/**
 * Answer the one explorer lookup a fee bump's broadcast makes for its
 * original, `fixture`: what spends each of its outputs (its one output,
 * unless `spenders` says otherwise). The original's bytes are never read
 * again at broadcast: its output count comes with the bump's claim.
 */
function explorerShowsOriginal(spenders: (string | undefined)[] = [undefined]) {
  getTxOutspendsMock.mockResolvedValueOnce(
    spenders.map(spender =>
      spender === undefined
        ? { spent: false }
        : { spent: true, txid: spender, vin: 0, status: { confirmed: false } }
    )
  )
}

function expectNoPayloadLeak(result: unknown) {
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(fixture.rawTxHex)
  expect(serialized).not.toContain(fixture.psbtHex)
  expect(serialized).not.toContain('127.0.0.1')
  expect(serialized).not.toContain('<html>')
}

function newController() {
  const wallet = new WalletController()
  wallet.qbitBroadcastProbeDelayMs = 0
  // One dispatch per call: the mocked client cannot say what a re-send of
  // the same bytes would get. Re-sends are covered through the real API
  // client in wallet-controller-qbit-broadcast-resend.test.ts.
  wallet.qbitBroadcastResendDelaysMs = []
  return wallet
}

/** The claim the wallet mints when it signs the fixture as its own send. */
function walletClaim(): QbitSendBroadcastClaim {
  return {
    chain: ChainType.QBIT_REGTEST,
    address: fixture.address,
    origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
    txid: fixture.txid,
    outpoints: [{ txid: SOURCE_TXID, vout: 0 }],
    // Not a fee bump.
    replaces: null,
  }
}

/**
 * The fixture's input once its transaction went out: the claim that
 * reserved it is consumed, so nothing claims the input any more, yet it
 * stays reserved as recently spent, because the explorer can keep listing it
 * for a while after the node took the spend.
 */
async function expectInputSpentNotClaimed(address = fixture.address) {
  await expect(
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, address)
  ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
  // The claim check runs first: a held claim would refuse as claimed.
  await expect(
    qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [{ txid: SOURCE_TXID, vout: 0 }])
  ).rejects.toThrow('recent broadcast already spent')
}

/**
 * Sign the fixture the way the confirm screen does for a send the wallet
 * built: a local P2MR account, the identity fixed at creation, and neither a
 * provider context nor a claim on the request.
 */
async function signWalletSend(
  wallet: WalletController,
  fx: ReturnType<typeof signedFixture> = fixture,
  request: Partial<ToSignData> = {}
) {
  const account = {
    type: KeyringType.QbitHdKeyring,
    address: fixture.address,
    pubkey: fixture.pubkeyHex,
    key: 'account-0',
    flag: 0,
    index: 0,
  }
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValueOnce(account as any)
  vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue(account as any)
  vi.mocked(keyringService.signP2mrPsbtWithCounter).mockResolvedValueOnce({
    psbt: fx.signing.psbt,
    signed: fx.signing.signed,
    counterResults: [],
  } as any)
  return wallet.signPsbtV2({
    psbtHex: fx.unsignedPsbtHex,
    toSignInputs: [],
    qbitP2mrSigningKeys: [{ inputIndex: 0, publicKey: fx.pubkeyHex, leafHash: fx.leafHashHex }],
    qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: fx.txid },
    ...request,
  })
}

/**
 * Reserve the fixture the way the signer screen does for a send the wallet
 * built for an account that signs outside the wallet: the request a local
 * signer would have received, and the bytes the user pasted or scanned.
 */
async function reserveExternalWalletSend(
  wallet: WalletController,
  signedTxData = fixture.psbtHex,
  keyringType: KeyringType = KeyringType.ReadonlyKeyring,
  request: Partial<ToSignData> = {},
  /** The account selected when the bytes come back: the building one unless given. */
  selected: { address: string; pubkey: string } = {
    address: fixture.address,
    pubkey: fixture.pubkeyHex,
  }
) {
  const account = {
    type: keyringType,
    address: selected.address,
    pubkey: selected.pubkey,
    key: 'account-0',
    flag: 0,
    index: 0,
  }
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValueOnce(account as any)
  return wallet.reserveExternallySignedQbitSend(
    {
      psbtHex: fixture.unsignedPsbtHex,
      toSignInputs: [],
      qbitP2mrSigningKeys: [
        { inputIndex: 0, publicKey: fixture.pubkeyHex, leafHash: fixture.leafHashHex },
      ],
      qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: fixture.txid },
      ...request,
    },
    signedTxData
  )
}

describe('WalletController.broadcastQbitTx', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    await qbitSendGuardService.resetAllData()
  })

  it('reports structured success with the txid computed before dispatch', async () => {
    const wallet = newController()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)

    await expect(wallet.broadcastQbitTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    expect(broadcastTxMock).toHaveBeenCalledWith(fixture.rawTxHex)
    expect(getTxStatusMock).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('accepts a raw transaction hex and an upper-cased txid echo', async () => {
    const wallet = newController()
    broadcastTxMock.mockResolvedValueOnce(` ${fixture.txid.toUpperCase()}\n`)

    await expect(wallet.broadcastQbitTx(fixture.rawTxHex)).resolves.toMatchObject({
      success: true,
      txid: fixture.txid,
    })
  })

  it('proves non-submission for an unreadable payload without touching the network', async () => {
    const wallet = newController()

    const result = await wallet.broadcastQbitTx('not-a-transaction')

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
      detail: expect.any(String),
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(getTxStatusMock).not.toHaveBeenCalled()
    expectNoPayloadLeak(result)
  })

  it('proves non-submission when the send guard refuses before dispatch', async () => {
    const wallet = newController()
    // Another approved send already claims this transaction's only input.
    await qbitSendGuardService.runWithBroadcastClaim(claimFor('ee'.repeat(32)), async () => 'ok')

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: 'Qbit transaction spends an input claimed by an approved send',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(getTxStatusMock).not.toHaveBeenCalled()
  })

  it('refuses a retry whose expected network no longer matches the wallet', async () => {
    const wallet = newController()

    const result = await wallet.broadcastQbitTx(fixture.psbtHex, undefined, ChainType.QBIT_MAINNET)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_MAINNET,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
  })

  it('refuses bytes for any transaction other than the expected one, before dispatch', async () => {
    const wallet = newController()

    // An external or cold-wallet signer returned valid bytes, but for another
    // transaction than the one the wallet built and fixed the identity for.
    const result = await wallet.broadcastQbitTx(
      otherFixture.psbtHex,
      undefined,
      ChainType.QBIT_REGTEST,
      fixture.txid
    )

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
      detail: 'signed transaction does not match the approved transaction',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(getTxStatusMock).not.toHaveBeenCalled()
    expectNoPayloadLeak(result)
    expect(JSON.stringify(result)).not.toContain(otherFixture.txid)

    // An expectation that cannot name a transaction refuses the same way and
    // reports no txid at all.
    await expect(
      wallet.broadcastQbitTx(fixture.psbtHex, undefined, ChainType.QBIT_REGTEST, 'not-a-txid')
    ).resolves.toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
      detail: 'signed transaction does not match the approved transaction',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()

    // The expected transaction itself still goes out, whatever the casing.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        fixture.psbtHex,
        undefined,
        ChainType.QBIT_REGTEST,
        ` ${fixture.txid.toUpperCase()} `
      )
    ).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    expect(broadcastTxMock).toHaveBeenCalledWith(fixture.rawTxHex)
  })

  it('binds a wallet-built send to the network and txid fixed at signing and reserves its inputs, before any broadcast', async () => {
    const wallet = newController()

    const signedData = await signWalletSend(wallet)

    // No provider claim on the request: the wallet minted its own at signing,
    // and the identity names the same network and txid.
    expect(signedData.qbitBroadcastIdentity).toEqual({
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
    })
    expect(signedData.qbitSendBroadcastClaim).toEqual(walletClaim())
    const identity = signedData.qbitBroadcastIdentity!
    const claim = signedData.qbitSendBroadcastClaim!

    // The wallet switches network before the bytes leave: a broadcast bound
    // to the captured network is refused before dispatch instead of going
    // to whichever network is selected now.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, identity.chain, identity.txid)
    ).resolves.toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()

    // Back on the captured network the same bytes go out under the txid fixed
    // at signing, without signing again: the claim is consumed, and the input
    // stays reserved as recently spent.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    broadcastTxMock.mockResolvedValueOnce(identity.txid)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, identity.chain, identity.txid)
    ).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: identity.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenCalledWith(fixture.rawTxHex)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()
  })

  it('reserves the inputs of a wallet-built send from signing until its broadcast is proven accepted', async () => {
    const wallet = newController()

    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!

    // From signing on, no other send flow sees the input or can sign over it.
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('claimed by an approved send')
    const conflicting = await wallet.broadcastQbitTx(
      otherFixture.psbtHex,
      undefined,
      ChainType.QBIT_REGTEST,
      otherFixture.txid
    )
    expect(conflicting).toMatchObject({
      success: false,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()

    // An ambiguous broadcast keeps the reservation: the retained bytes are
    // still retryable, so the inputs must not become selectable again.
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown' })
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    // A status check that finds the transaction consumes the claim, exactly
    // as a clean broadcast would have.
    probePending()
    await expect(
      wallet.checkQbitBroadcastStatus(claim.txid, ChainType.QBIT_REGTEST, claim)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
    await expectInputSpentNotClaimed()
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('never proves non-submission for a retry whose claim an earlier, lost success already consumed', async () => {
    const wallet = newController()
    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!

    // The node accepts the first broadcast and the guard consumes the claim,
    // but the answer dies on the way to the UI (the port closed), so the UI
    // holds an unknown verdict and the same claim, and retries.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'broadcast' })
    await expectInputSpentNotClaimed()

    // The retry is refused before dispatch, but that refusal is not proof
    // the payment never went out: the lookup finds it, and the retry reports
    // the success the UI lost instead of freeing the inputs under it.
    probePending()
    const found = await wallet.broadcastQbitTx(
      signedData.psbtHex!,
      claim,
      claim.chain,
      claim.txid
    )
    expect(found).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)

    // When the lookup cannot find it either (indexer lag, or a background
    // restart that dropped every claim), the verdict stays inconclusive and
    // keeps the transaction's identity so the UI can probe again.
    probeGone()
    const inconclusive = await wallet.broadcastQbitTx(
      signedData.psbtHex!,
      claim,
      claim.chain,
      claim.txid
    )
    expect(inconclusive).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: 'Qbit send broadcast claim is not active',
    })
    getTxStatusMock.mockRejectedValueOnce(networkError())
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown', lookup: 'unavailable' })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)

    // A conflicting transaction is still a plain refusal, and nothing about
    // it is ever dispatched: the input stays reserved as recently spent, so
    // no claim can be minted over it and no other transaction can spend it.
    await expect(
      qbitSendGuardService.runWithBroadcastClaim(claimFor('ee'.repeat(32)), async () => 'ok')
    ).rejects.toThrow('recent broadcast already spent')
    await expect(wallet.broadcastQbitTx(otherFixture.psbtHex)).resolves.toMatchObject({
      success: false,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: 'Qbit transaction spends an input a recent broadcast already spent',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a wallet-built send reserved through a proven rejection until the user abandons it', async () => {
    const wallet = newController()

    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()

    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'not_sent', reason: 'rejected' })

    // The verdict alone does not spend the reservation: the recovery screen
    // may still retry these exact bytes. Leaving that screen releases it
    // through the same exact-match release a provider claim uses.
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(true)
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set())
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(false)
  })

  it('names the txid a wallet-built send is bound to on every pre-dispatch refusal, so abandoning it releases the claim', async () => {
    const wallet = newController()

    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!
    const identity = signedData.qbitBroadcastIdentity!
    const reserved = () =>
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)

    // Another window switches networks before the first broadcast. Nothing
    // is sent, and the verdict names the network and txid the claim names:
    // the recovery screen releases a claim only for a verdict that names
    // both, so a verdict without the txid would leave these inputs reserved
    // after the retained bytes are discarded, until the background restarts.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    const switched = await wallet.broadcastQbitTx(
      signedData.psbtHex!,
      claim,
      identity.chain,
      identity.txid
    )
    expect(switched).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    // The same when the retained bytes no longer parse, and when the bytes
    // are not the expected transaction while the expectation itself is
    // malformed: the claim's txid is reported, never the bytes' own.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    const unreadable = await wallet.broadcastQbitTx(
      'not-a-transaction',
      claim,
      identity.chain,
      identity.txid
    )
    expect(unreadable).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
    })
    const mismatched = await wallet.broadcastQbitTx(
      otherFixture.psbtHex,
      claim,
      identity.chain,
      'not-a-txid'
    )
    expect(mismatched).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
      detail: 'signed transaction does not match the approved transaction',
    })
    expect(JSON.stringify(mismatched)).not.toContain(otherFixture.txid)
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(getTxStatusMock).not.toHaveBeenCalled()

    // Every verdict names the claim's own network and txid, which is exactly
    // what the recovery screen checks before releasing the claim on exit.
    for (const verdict of [switched, unreadable, mismatched]) {
      expect(verdict).toMatchObject({ chain: claim.chain, txid: claim.txid })
    }
    await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(true)
    await expect(reserved()).resolves.toEqual(new Set())
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('aborts before dispatch when the network switches while the guard queue is busy', async () => {
    const wallet = newController()
    vi.mocked(preferenceService.getChainType)
      .mockReturnValueOnce(ChainType.QBIT_REGTEST)
      .mockReturnValue(ChainType.QBIT_MAINNET)

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    expect(result).not.toHaveProperty('lookup')
    expect(broadcastTxMock).not.toHaveBeenCalled()
  })

  it('reports not_sent only after a definitive rejection and repeated absence probes', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'rejected',
      lookup: 'gone',
      detail: 'HTTP 400: bad-txns-inputs-missingorspent',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    expect(getTxStatusMock).toHaveBeenCalledTimes(QBIT_BROADCAST_ABSENCE_PROBES)
    expectNoPayloadLeak(result)
  })

  it('upgrades a rejection to success when a later absence probe finds the transaction', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection('dust'))
    probeGone()
    probePending()

    await expect(wallet.broadcastQbitTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a rejection inconclusive when an absence probe cannot reach the network', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection('dust'))
    probeGone()
    getTxStatusMock.mockRejectedValueOnce(networkError())

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      outcome: 'unknown',
      reason: 'rejected',
      lookup: 'unavailable',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['already in mempool', 'txn-already-in-mempool', 'rejected'],
    [
      'already in chain',
      '{"error":{"code":-27,"message":"Transaction already in block chain"}}',
      'rejected',
    ],
    ['generic failure', '{"error":"Failed to send transaction"}', 'server'],
    ['empty body', '', 'server'],
  ])('never turns a 400 %s answer plus absence into not_sent', async (_label, body, reason) => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection(body))
    probeGone()

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      txid: fixture.txid,
      outcome: 'unknown',
      reason,
      lookup: 'gone',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an HTML proxy page', PROXY_400_BODY],
    ['plain gateway text', 'Bad Request'],
    ['a JSON proxy envelope', '{"error":{"code":400,"message":"Bad Request"}}'],
  ])(
    'never turns a 400 with %s plus repeated absence into not_sent or shows the body',
    async (_label, body) => {
      const wallet = newController()
      broadcastTxMock.mockRejectedValueOnce(rejection(body))
      for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()

      const result = await wallet.broadcastQbitTx(fixture.psbtHex)

      expect(result).toEqual({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: fixture.txid,
        outcome: 'unknown',
        reason: 'server',
        lookup: 'gone',
        detail: 'HTTP 400',
      })
      // An unrecognized answer gets the single inconclusive probe, not the
      // absence series reserved for a real node rejection.
      expect(getTxStatusMock).toHaveBeenCalledTimes(1)
      expectNoPayloadLeak(result)
      expect(JSON.stringify(result)).not.toContain('nginx')
      expect(JSON.stringify(result)).not.toContain('Bad Request')
    }
  )

  it('reports success when an already-known rejection is backed by a confirmed lookup', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection('txn-already-known'))
    getTxStatusMock.mockResolvedValueOnce({ confirmed: true })

    await expect(wallet.broadcastQbitTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
  })

  it.each([
    ['network loss', networkError(), 'network'],
    [
      'timeout',
      new QbitApiError('timeout', `request timed out after 15000ms: ${ENDPOINT}`, {
        url: ENDPOINT,
      }),
      'timeout',
    ],
    [
      'gateway error',
      new QbitApiError('http', `HTTP 502 from ${ENDPOINT}: ${HTML_BODY}`, {
        status: 502,
        url: ENDPOINT,
        responseBody: HTML_BODY,
      }),
      'server',
    ],
    [
      'rate limit',
      new QbitApiError('rate_limit', `HTTP 429 from ${ENDPOINT}`, { status: 429, url: ENDPOINT }),
      'server',
    ],
    ['missing endpoint', notFound(), 'server'],
    [
      'unreadable body',
      new QbitApiError('parse', `failed to read response body from ${ENDPOINT}`, { url: ENDPOINT }),
      'invalid_response',
    ],
    ['unexpected throw', new Error(`socket hang up ${ENDPOINT}`), 'unexpected'],
  ])('keeps %s with an absent lookup at unknown', async (_label, error, reason) => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(error)
    probeGone()

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason,
      lookup: 'gone',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(1)
    expectNoPayloadLeak(result)
  })

  it('reports success when the lost response hides a pending transaction', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probePending()

    await expect(wallet.broadcastQbitTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
  })

  it('reports success when the lost response hides a confirmed transaction', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    getTxStatusMock.mockResolvedValueOnce({ confirmed: true })

    await expect(wallet.broadcastQbitTx(fixture.psbtHex)).resolves.toMatchObject({
      success: true,
      via: 'lookup',
    })
  })

  it('keeps the verdict unknown when the follow-up lookup itself fails', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    getTxStatusMock.mockRejectedValueOnce(networkError())

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'network',
      lookup: 'unavailable',
      detail: 'network error: [url] (TypeError: fetch failed)',
    })
  })

  it('treats a network switch before the lookup as an unavailable probe', async () => {
    const wallet = newController()
    vi.mocked(preferenceService.getChainType)
      .mockReturnValueOnce(ChainType.QBIT_REGTEST)
      .mockReturnValueOnce(ChainType.QBIT_REGTEST)
      .mockReturnValue(ChainType.QBIT_MAINNET)
    broadcastTxMock.mockRejectedValueOnce(rejection('dust'))

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      outcome: 'unknown',
      reason: 'rejected',
      lookup: 'unavailable',
    })
    expect(getTxStatusMock).not.toHaveBeenCalled()
  })

  it('keeps every absence probe on the captured network when the wallet switches mid-lookup', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection('dust'))
    // The status request is answered only after the wallet has moved to
    // mainnet; the follow-up getTx and the remaining probes must still run
    // against the regtest client that was captured before dispatch.
    getTxStatusMock.mockImplementationOnce(async () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
      return { confirmed: false }
    })
    getTxMock.mockResolvedValueOnce({ txid: fixture.txid })

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(getTxMock).toHaveBeenCalledTimes(1)
    expect(apiClientMock.mock.calls.map(([options]) => options)).toEqual([
      {
        baseUrl: REGTEST_ENDPOINT,
        timeoutMs: QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
        fetchFn: expect.any(Function),
      },
    ])
    expect(apiClientMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: MAINNET_ENDPOINT })
    )
  })

  it('stops probing on the captured network once the wallet has switched between probes', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(rejection('dust'))
    getTxStatusMock.mockImplementationOnce(async () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
      throw notFound()
    })

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'rejected',
      lookup: 'unavailable',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(1)
    expect(apiClientMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: MAINNET_ENDPOINT })
    )
  })

  it('does not trust a 2xx response that fails to echo the txid', async () => {
    const wallet = newController()
    broadcastTxMock.mockResolvedValueOnce(HTML_BODY)
    probeGone()

    const result = await wallet.broadcastQbitTx(fixture.psbtHex)

    expect(result).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'invalid_response',
      lookup: 'gone',
      detail: 'broadcast response did not echo the expected transaction id',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(1)
    expectNoPayloadLeak(result)
    expect(JSON.stringify(result)).not.toContain('Bad gateway')
  })

  it('keeps the send claim reserved after a non-echoing 2xx so the exact retry is still allowed', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    broadcastTxMock.mockResolvedValueOnce(HTML_BODY)
    probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)

    const first = (await wallet.broadcastQbitTx(fixture.psbtHex, claim)) as QbitBroadcastFailure
    expect(first).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'invalid_response',
      lookup: 'gone',
      detail: 'broadcast response did not echo the expected transaction id',
    })
    expectNoPayloadLeak(first)
    expect(JSON.stringify(first)).not.toContain('Bad gateway')
    // The guard must not have consumed the claim on a response nobody trusts.
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    const retry = await wallet.broadcastQbitTx(fixture.psbtHex, claim, first.chain)

    expect(retry).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock.mock.calls).toEqual([[fixture.rawTxHex], [fixture.rawTxHex]])
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    await expectInputSpentNotClaimed()
  })

  it('consumes the send claim when a lookup proves a non-echoing 2xx still reached the node', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    broadcastTxMock.mockResolvedValueOnce(HTML_BODY)
    probePending()

    await expect(wallet.broadcastQbitTx(fixture.psbtHex, claim)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    await expectInputSpentNotClaimed()
  })

  it('rebroadcasts the exact retained bytes with the same txid and never signs again', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)

    const first = (await wallet.broadcastQbitTx(fixture.psbtHex)) as QbitBroadcastFailure
    expect(first).toMatchObject({ success: false, outcome: 'unknown', txid: fixture.txid })

    const retry = await wallet.broadcastQbitTx(fixture.psbtHex, undefined, first.chain)

    expect(retry).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock.mock.calls).toEqual([[fixture.rawTxHex], [fixture.rawTxHex]])
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
  })

  it('keeps a send claim active across an inconclusive failure so the retry is still allowed', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)

    await expect(wallet.broadcastQbitTx(fixture.psbtHex, claim)).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
    })
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    await expect(wallet.broadcastQbitTx(fixture.psbtHex, claim)).resolves.toMatchObject({
      success: true,
      via: 'broadcast',
    })
    await expectInputSpentNotClaimed()
  })

  it('keeps the send claim reserved after a proven rejection so the same-byte retry is still allowed', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)

    const first = (await wallet.broadcastQbitTx(fixture.psbtHex, claim)) as QbitBroadcastFailure

    expect(first).toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'rejected',
      lookup: 'gone',
    })
    // The verdict alone must not spend the claim: the recovery screen may
    // still rebroadcast these exact bytes, and the guard refuses a retry
    // whose claim is no longer active. Releasing is the UI's decision when
    // the user abandons the verdict.
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    const retry = await wallet.broadcastQbitTx(fixture.psbtHex, claim, first.chain)

    expect(retry).toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock.mock.calls).toEqual([[fixture.rawTxHex], [fixture.rawTxHex]])
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(keyringService.preflightP2mrPsbtSigning).not.toHaveBeenCalled()
    await expectInputSpentNotClaimed()
  })

  it('consumes a send claim when the lookup proves the node accepted the transaction', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probePending()

    await expect(wallet.broadcastQbitTx(fixture.psbtHex, claim)).resolves.toMatchObject({
      success: true,
      via: 'lookup',
    })
    await expectInputSpentNotClaimed()
  })

  it('leaves the bare pushTx contract untouched', async () => {
    const wallet = newController()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex)).resolves.toBe(fixture.txid)

    broadcastTxMock.mockRejectedValueOnce(networkError())
    await expect(wallet.pushTx(fixture.psbtHex)).rejects.toBeInstanceOf(QbitApiError)
    expect(getTxStatusMock).not.toHaveBeenCalled()
  })

  it('still honors a claim passed to pushTx, keeping its inputs reserved once it is consumed', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'approved')

    broadcastTxMock.mockRejectedValueOnce(networkError())
    await expect(wallet.pushTx(fixture.psbtHex, claim)).rejects.toBeInstanceOf(QbitApiError)
    await expect(
      qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
    ).rejects.toThrow('claimed by an approved send')

    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex, claim)).resolves.toBe(fixture.txid)
    await expectInputSpentNotClaimed()
  })

  it('reserves the inputs of a pushTx only once the node accepts it', async () => {
    const wallet = newController()
    const reserved = () =>
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)

    // A failed bare push, conclusive or not, records nothing.
    broadcastTxMock.mockRejectedValueOnce(
      rejection('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}')
    )
    await expect(wallet.pushTx(fixture.psbtHex)).rejects.toBeInstanceOf(QbitApiError)
    broadcastTxMock.mockRejectedValueOnce(
      new QbitApiError('rate_limit', `HTTP 429 from ${ENDPOINT}`, { status: 429, url: ENDPOINT })
    )
    await expect(wallet.pushTx(fixture.psbtHex)).rejects.toBeInstanceOf(QbitApiError)
    await expect(reserved()).resolves.toEqual(new Set())

    // Accepted bytes were signed by the account, and spend the input now.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex)).resolves.toBe(fixture.txid)
    await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(wallet.broadcastQbitTx(otherFixture.psbtHex)).resolves.toMatchObject({
      success: false,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    // The same bytes may still go out again.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex)).resolves.toBe(fixture.txid)
    expect(broadcastTxMock).toHaveBeenCalledTimes(4)
  })

  it("keeps a lost answer's inputs reserved after its claim is released", async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'approved')

    // The node took the bytes but the answer timed out and the lookup lags.
    broadcastTxMock.mockRejectedValueOnce(
      new QbitApiError('timeout', `timeout: ${ENDPOINT}`, { url: ENDPOINT })
    )
    probeGone()
    await expect(
      wallet.broadcastQbitTx(fixture.psbtHex, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown', reason: 'timeout' })

    // Whatever later drops the claim, the input stays reserved as possibly
    // spent, so a retry cannot build a conflicting second payment over it.
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(true)
    await expectInputSpentNotClaimed()
    await expect(
      qbitSendGuardService.runWithBroadcastClaim(claimFor('ee'.repeat(32)), async () => 'again')
    ).rejects.toThrow('recent broadcast already spent')
  })

  it('refuses a provider signature over a just-broadcast input, but not over the same transaction', async () => {
    const wallet = newController()
    const original = await signWalletSend(wallet)
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        original.psbtHex!,
        original.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        fixture.txid
      )
    ).resolves.toMatchObject({ success: true })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockReset()
    const providerContext = {
      origin: 'https://dapp.example',
      account: fixture.address,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest' as const,
    }

    // The dapp would get bytes it can broadcast anywhere, replacing the
    // pending payment: refused before a one-time signature is spent.
    await expect(signWalletSend(wallet, otherFixture, { providerContext })).rejects.toThrow(
      'recent broadcast already spent'
    )
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockReset()

    // Signing the transaction that is already out changes nothing.
    await expect(signWalletSend(wallet, fixture, { providerContext })).resolves.toMatchObject({
      psbtHex: expect.any(String),
    })
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('refuses to sign a second send over a just-broadcast input, but lets a fee bump of it through', async () => {
    const wallet = newController()
    const original = await signWalletSend(wallet)
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        original.psbtHex!,
        original.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        fixture.txid
      )
    ).resolves.toMatchObject({ success: true })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockClear()

    // A send built from a stale output list spends the same input: refused
    // before a single one-time signature is spent on it.
    await expect(signWalletSend(wallet, otherFixture)).rejects.toThrow(
      'recent broadcast already spent'
    )
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockReset()

    // A fee bump replaces the original on purpose, so it may take it over.
    const feeBump = {
      originalTxid: fixture.txid,
      originalOutputCount: 1,
      originalFee: 10_000,
      replacementFee: 11_000,
      feeDelta: 1_000,
      originalFeeRate: 2,
      replacementFeeRate: 2.2,
      replacementVsize: 5_000,
      changeBefore: 0,
      changeAfter: 0,
      changeDropped: false,
    }
    const replacement = await signWalletSend(wallet, otherFixture, { feeBump })
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
    expect(replacement.qbitSendBroadcastClaim?.replaces).toBe(fixture.txid)
    // Right before it goes out, the explorer still shows nothing spending
    // the original's outputs.
    explorerShowsOriginal()
    broadcastTxMock.mockResolvedValueOnce(otherFixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        replacement.psbtHex!,
        replacement.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        otherFixture.txid
      )
    ).resolves.toMatchObject({ success: true, txid: otherFixture.txid })

    // The replaced original cannot be pushed back over its replacement.
    await expect(wallet.pushTx(fixture.psbtHex)).rejects.toThrow('recent broadcast already spent')
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
  })
})

describe('WalletController.broadcastQbitProviderTx', () => {
  const reserved = () =>
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
  const input = `${SOURCE_TXID}:0`
  /** The user approved signing the fixture for a dapp (provider signPsbt). */
  const approveSigning = (wallet: WalletController) =>
    wallet.recordQbitProviderSignings([{ chain: ChainType.QBIT_REGTEST, txid: fixture.txid }])
  const timeout = () => new QbitApiError('timeout', `timeout: ${ENDPOINT}`, { url: ENDPOINT })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await qbitSendGuardService.resetAllData()
  })

  it('answers with the txid computed from the bytes once the node echoes it', async () => {
    const wallet = newController()
    const accepted = {
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    }
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual(accepted)
    broadcastTxMock.mockResolvedValueOnce(fixture.txid.toUpperCase())
    await expect(wallet.broadcastQbitProviderTx(fixture.rawTxHex)).resolves.toEqual(accepted)

    expect(broadcastTxMock.mock.calls).toEqual([[fixture.rawTxHex], [fixture.rawTxHex]])
    expect(getTxStatusMock).not.toHaveBeenCalled()
    // Accepted bytes spend the input now, whoever got them signed.
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })

  it('reconciles a lost answer by txid, reporting the transaction a lookup finds as sent', async () => {
    const wallet = newController()
    // The node took the bytes, but the answer timed out.
    broadcastTxMock.mockRejectedValueOnce(timeout())
    probePending()

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'lookup',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    // Found on the network, so its inputs are spent: recorded like an
    // accepted broadcast, approved or not.
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })

  it.each([
    ['a timeout', timeout, 'timeout'],
    ['a network error', networkError, 'network'],
    [
      'a gateway error',
      () =>
        new QbitApiError('http', `HTTP 502 from ${ENDPOINT}`, {
          status: 502,
          url: ENDPOINT,
          responseBody: HTML_BODY,
        }),
      'server',
    ],
    ['a 2xx that does not echo the txid', undefined, 'invalid_response'],
  ] as const)(
    'reports %s a lookup cannot settle as unknown, naming the transaction',
    async (_label, failure, reason) => {
      const wallet = newController()
      if (failure) broadcastTxMock.mockRejectedValueOnce(failure())
      else broadcastTxMock.mockResolvedValueOnce(HTML_BODY)
      probeGone()

      const result = await wallet.broadcastQbitProviderTx(fixture.psbtHex)

      expect(result).toMatchObject({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: fixture.txid,
        outcome: 'unknown',
        reason,
        lookup: 'gone',
      })
      expect(getTxStatusMock).toHaveBeenCalledTimes(1)
      expectNoPayloadLeak(result)
      expect(JSON.stringify(result)).not.toContain('Bad gateway')
    }
  )

  it('keeps the inputs of an unknown push reserved only when the user approved signing the transaction', async () => {
    const wallet = newController()
    broadcastTxMock.mockRejectedValueOnce(timeout())
    probeGone()

    // No approval: the push is the dapp's own, and reserving the outputs it
    // names would let it freeze the account's funds.
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      outcome: 'unknown',
    })
    await expect(reserved()).resolves.toEqual(new Set())

    await approveSigning(wallet)
    broadcastTxMock.mockRejectedValueOnce(timeout())
    probeGone()
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      outcome: 'unknown',
      txid: fixture.txid,
    })

    // The node may hold the transaction: no other spend of its input, by the
    // wallet or the dapp, can replace it.
    await expect(reserved()).resolves.toEqual(new Set([input]))
    await expect(
      qbitSendGuardService.runWithBroadcastClaim(claimFor(otherFixture.txid), async () => 'signed')
    ).rejects.toThrow('recent broadcast already spent')
    await expect(wallet.broadcastQbitProviderTx(otherFixture.psbtHex)).resolves.toMatchObject({
      success: false,
      txid: otherFixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)

    // A retry of the same bytes still goes out, and settles the outcome.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      success: true,
      txid: fixture.txid,
    })
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })

  it('decides a push requested right after the approval was recorded by that approval', async () => {
    const wallet = newController()
    // Not awaited, as the provider does not await it before answering, and
    // an identity the guard refuses does not fail the others.
    vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const recorded = wallet.recordQbitProviderSignings([
      undefined,
      { chain: ChainType.QBIT_REGTEST, txid: 'not-a-txid' },
      { chain: ChainType.QBIT_REGTEST, txid: fixture.txid },
    ])
    broadcastTxMock.mockRejectedValueOnce(timeout())
    probeGone()

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      outcome: 'unknown',
    })
    await expect(recorded).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })

  it('forgets no reservation when the node definitively rejects the pushed bytes', async () => {
    const wallet = newController()
    await approveSigning(wallet)
    broadcastTxMock.mockRejectedValueOnce(timeout())
    probeGone()
    await wallet.broadcastQbitProviderTx(fixture.psbtHex)
    await expect(reserved()).resolves.toEqual(new Set([input]))

    // A txid does not cover the witness: these may not be the bytes the
    // node may hold, so their rejection proves nothing about those.
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-26,"message":"mandatory-script-verify-flag-failed"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toMatchObject({
      outcome: 'not_sent',
      reason: 'rejected',
    })
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })

  it('reports not_sent only before dispatch or after a definitive rejection with absence proven', async () => {
    const wallet = newController()

    await expect(wallet.broadcastQbitProviderTx('zz')).resolves.toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
    })

    // An input a wallet send holds is refused before the bytes leave.
    const claim = claimFor(otherFixture.txid)
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    const blocked = await wallet.broadcastQbitProviderTx(fixture.psbtHex)
    expect(blocked).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: 'Qbit transaction spends an input claimed by an approved send',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    await qbitSendGuardService.releaseBroadcastClaim(claim)

    broadcastTxMock.mockRejectedValueOnce(
      rejection('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}')
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()
    const rejected = await wallet.broadcastQbitProviderTx(fixture.psbtHex)
    expect(rejected).toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'rejected',
      lookup: 'gone',
      detail: 'HTTP 400: min relay fee not met',
    })
    expect(getTxStatusMock).toHaveBeenCalledTimes(QBIT_BROADCAST_ABSENCE_PROBES)
    expectNoPayloadLeak(rejected)
    await expect(reserved()).resolves.toEqual(new Set())
  })

  it('reports an unexpected throw as unknown, naming the transaction', async () => {
    const wallet = newController()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.assign(wallet, {
      attemptQbitBroadcast: vi.fn().mockRejectedValue(new Error('port closed')),
    })
    const unexpected = {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'unexpected',
    }

    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual(unexpected)
    await expect(reserved()).resolves.toEqual(new Set())

    // The throw may come after the bytes left: an approved transaction's
    // inputs stay reserved, as for any other unknown outcome.
    await approveSigning(wallet)
    await expect(wallet.broadcastQbitProviderTx(fixture.psbtHex)).resolves.toEqual(unexpected)
    await expect(reserved()).resolves.toEqual(new Set([input]))
  })
})

describe('WalletController recent-spend eviction', () => {
  const account = {
    type: KeyringType.QbitHdKeyring,
    address: fixture.address,
    pubkey: fixture.pubkeyHex,
    key: 'account-0',
    flag: 0,
    index: 0,
  }
  const spentInput = { txid: SOURCE_TXID, vout: 0, satoshis: 50_000 }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    await qbitSendGuardService.resetAllData()
  })

  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it("keeps an accepted send's input out of the output snapshot until a probe finds its spender confirmed", async () => {
    const wallet = newController()
    const signedData = await signWalletSend(wallet)
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        signedData.psbtHex!,
        signedData.qbitSendBroadcastClaim,
        ChainType.QBIT_REGTEST,
        fixture.txid
      )
    ).resolves.toMatchObject({ success: true })
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    // The explorer's output list lags the node and still lists the input.
    vi.spyOn(wallet as any, 'qbitAccountUtxosOn').mockResolvedValue([spentInput])
    const snapshotUtxos = async () => (await wallet.getQbitUtxoSnapshot()).utxos

    // Right after the broadcast nothing is probed and the input is held back.
    await expect(snapshotUtxos()).resolves.toEqual([])
    expect(getTxStatusMock).not.toHaveBeenCalled()

    // Pending, gone within the grace period (the index lags), or a lookup
    // that fails: all keep it held back.
    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    probePending()
    await expect(snapshotUtxos()).resolves.toEqual([])
    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    probeGone()
    await expect(snapshotUtxos()).resolves.toEqual([])
    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    getTxStatusMock.mockRejectedValueOnce(networkError())
    await expect(snapshotUtxos()).resolves.toEqual([])
    // Probes are spaced out, not repeated on every read.
    await expect(snapshotUtxos()).resolves.toEqual([])
    expect(getTxStatusMock).toHaveBeenCalledTimes(3)
    expect(getTxStatusMock).toHaveBeenCalledWith(fixture.txid)

    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    getTxStatusMock.mockResolvedValueOnce({ confirmed: true })
    await expect(snapshotUtxos()).resolves.toEqual([expect.objectContaining(spentInput)])
  })

  it('settles a provider claim whose outcome is unknown as spent, so a probe can free its input', async () => {
    const wallet = newController()
    const claim = claimFor()
    const request = await wallet.openQbitProviderSendRequest(claim)
    await qbitSendGuardService.runWithProviderBroadcastClaim(claim, async () => 'approved')
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(fixture.psbtHex, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown' })

    // Nothing holds a provider claim's bytes: settling its request as spent
    // keeps the input reserved without holding it until the background
    // restarts.
    await wallet.settleQbitProviderSendRequest(request, true)
    await expectInputSpentNotClaimed()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet as any, 'qbitAccountUtxosOn').mockResolvedValue([spentInput])
    advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    probeGone()
    await expect(wallet.getQbitUtxoSnapshot()).resolves.toMatchObject({
      utxos: [expect.objectContaining(spentInput)],
    })
  })

  it('waits only so long for a slow probe, keeping the input reserved until it answers', async () => {
    const wallet = newController()
    wallet.qbitRecentSpendProbeWaitMs = 5
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex)).resolves.toBe(fixture.txid)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet as any, 'qbitAccountUtxosOn').mockResolvedValue([spentInput])

    advance(QBIT_RECENT_SPEND_PROBE_INTERVAL_MS)
    let answer: (status: { confirmed: boolean }) => void = () => undefined
    getTxStatusMock.mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    // The explorer hangs: the read returns anyway, with the input held back.
    await expect(wallet.getQbitUtxoSnapshot()).resolves.toMatchObject({ utxos: [] })

    // The answer lands later and settles the record for the next read.
    answer({ confirmed: true })
    await vi.waitFor(async () => {
      await expect(wallet.getQbitUtxoSnapshot()).resolves.toMatchObject({
        utxos: [expect.objectContaining(spentInput)],
      })
    })
  })

  it("renews a held claim's reservation when a status check finds its transaction pending", async () => {
    const wallet = newController()
    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown' })

    // Near the expiry the failure screen checks again and finds it pending:
    // the input must stay reserved for another day from that answer.
    advance(QBIT_RECENT_SPEND_TTL_MS - 1)
    probePending()
    await expect(
      wallet.checkQbitBroadcastStatus(claim.txid, ChainType.QBIT_REGTEST, claim)
    ).resolves.toMatchObject({ found: true, state: 'pending' })
    advance(QBIT_RECENT_SPEND_TTL_MS - 1)
    await expectInputSpentNotClaimed()
  })

  it('frees the input of a spender still gone after the grace period', async () => {
    const wallet = newController()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(wallet.pushTx(fixture.psbtHex)).resolves.toBe(fixture.txid)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as any)
    vi.spyOn(wallet as any, 'qbitAccountUtxosOn').mockResolvedValue([spentInput])

    advance(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    probeGone()
    await expect(wallet.getQbitUtxoSnapshot()).resolves.toMatchObject({
      utxos: [expect.objectContaining(spentInput)],
    })
  })
})

describe('WalletController.broadcastQbitTx after a background restart', () => {
  const reservedKeys = (address = fixture.address) =>
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, address)
  const reserved = new Set([`${SOURCE_TXID}:0`])
  /** The account the fixture was built and signed for. */
  const buildingAccount = {
    type: KeyringType.QbitHdKeyring,
    address: fixture.address,
    pubkey: fixture.pubkeyHex,
    key: 'account-0',
    flag: 0,
    index: 0,
  }
  const otherAccount = {
    ...buildingAccount,
    address: 'qbrt1zanotheraccount',
    pubkey: '22'.repeat(32),
    key: 'account-1',
    index: 1,
  }

  /**
   * The background worker restarted between two UI requests: the guard's
   * memory is gone, while the page keeps the signed bytes and the claim
   * minted for them and reconnects on its next request.
   */
  const restartBackground = () => qbitSendGuardService.init()

  const waitForDispatch = async () => {
    while (broadcastTxMock.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    qbitSendGuardService.init()
  })

  afterEach(() => {
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    qbitSendGuardService.init()
  })

  /**
   * Sign the fixture as a wallet send, lose the first broadcast's answer
   * (an unknown verdict, the page keeps the bytes), and restart the worker
   * with the building account still selected.
   */
  async function signThenRestart(wallet: WalletController) {
    const signedData = await signWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown', reason: 'network' })
    await expect(reservedKeys()).resolves.toEqual(reserved)
    restartBackground()
    await expect(reservedKeys()).resolves.toEqual(new Set())
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)
    return { signedData, claim }
  }

  it('records the inputs of a wallet-built send a status check finds after the restart', async () => {
    const wallet = newController()
    const { claim } = await signThenRestart(wallet)

    probePending()
    await expect(
      wallet.checkQbitBroadcastStatus(claim.txid, ChainType.QBIT_REGTEST, claim)
    ).resolves.toMatchObject({ found: true, state: 'pending' })
    // Nothing held the claim, but the network holds its transaction: a
    // send built from a stale list must not replace it.
    await expectInputSpentNotClaimed()
  })

  it('restores the claim of a wallet-built send and dispatches the retained bytes once, without signing again', async () => {
    const wallet = newController()
    const { signedData, claim } = await signThenRestart(wallet)

    // The retry presents a claim the guard has never seen. The lookup
    // misses, so the claim is restored and these exact bytes go out under
    // it, consuming it as a minted claim would be consumed.
    probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toEqual({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
    expect(broadcastTxMock).toHaveBeenLastCalledWith(fixture.rawTxHex)
    expect(getTxStatusMock).toHaveBeenCalledTimes(2)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()

    // This worker now knows the claim was consumed: a retry whose answer was
    // lost is probed, and never dispatched again on a lookup miss.
    probePending()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'lookup' })
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
    await expectInputSpentNotClaimed()
  })

  it('keeps a restored claim reserved through an inconclusive dispatch and consumes it on the next retry', async () => {
    const wallet = newController()
    const { signedData, claim } = await signThenRestart(wallet)

    // One probe before the restoration, one after the dispatch fails.
    probeGone()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      reason: 'network',
      lookup: 'gone',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // Another transaction over the same input is refused meanwhile, exactly
    // as it was before the restart.
    await expect(wallet.broadcastQbitTx(otherFixture.psbtHex)).resolves.toMatchObject({
      success: false,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })

    // The next retry finds the claim held: straight to dispatch, no probe.
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'broadcast' })
    expect(getTxStatusMock).toHaveBeenCalledTimes(3)
    await expectInputSpentNotClaimed()
  })

  it('leaves a restored claim to the recovery screen after a proven rejection', async () => {
    const wallet = newController()
    const { signedData, claim } = await signThenRestart(wallet)

    probeGone()
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'not_sent', reason: 'rejected' })

    // The verdict alone does not spend the reservation; abandoning it does.
    await expect(reservedKeys()).resolves.toEqual(reserved)
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(true)
    await expect(reservedKeys()).resolves.toEqual(new Set())
  })

  it('refuses to restore the claim while another account is selected, and restores it once the building account is selected again', async () => {
    const wallet = newController()
    const { signedData, claim } = await signThenRestart(wallet)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as any)

    // No claim is filed under either address and nothing is dispatched; the
    // verdict stays the inconclusive one a lost claim gets, naming why. The
    // bytes may have gone out before the restart, so the input is recorded
    // as possibly spent under the address the claim names, and only there.
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: 'Qbit account changed since the transaction was created',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()
    await expect(reservedKeys(otherAccount.address)).resolves.toEqual(new Set())

    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)
    probeGone()
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'broadcast' })
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('never restores a provider claim', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'approved')
    restartBackground()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)

    probeGone()
    await expect(
      wallet.broadcastQbitTx(fixture.psbtHex, claim, claim.chain, claim.txid)
    ).resolves.toEqual({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: 'Qbit send broadcast claim is not active',
    })
    expect(broadcastTxMock).not.toHaveBeenCalled()
    // Nothing is restored, but the bytes may have gone out before the
    // restart: the input stays reserved as possibly spent.
    await expectInputSpentNotClaimed()
  })

  it('still reports the success a lookup finds, and restores nothing when the lookup cannot run', async () => {
    const wallet = newController()
    const { signedData, claim } = await signThenRestart(wallet)

    getTxStatusMock.mockRejectedValueOnce(networkError())
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: false, outcome: 'unknown', lookup: 'unavailable' })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()

    // The first broadcast had gone through after all.
    probePending()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({ success: true, via: 'lookup' })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()
  })

  it('defers a port disconnect during the restored attempt to its verdict', async () => {
    const wallet = newController()
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    const claim = signedData.qbitSendBroadcastClaim!
    restartBackground()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)

    // The page reconnects as a new port for the retry. The lookup misses,
    // the claim is restored under that port, and the node is slow to answer
    // while the page goes away. The guard queue holds every other operation
    // behind the in-flight broadcast, so the disconnect is observed only
    // once the node answers, and only then can the reservation be read.
    probeGone()
    let reject: (error: unknown) => void = () => undefined
    broadcastTxMock.mockReturnValueOnce(new Promise<string>((_, fail) => (reject = fail)))
    const attempt = wallet.runForUiPort('tab:2', () =>
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    )
    await waitForDispatch()
    const disconnected = wallet.onUiPortDisconnected('tab:2')

    // An inconclusive verdict keeps the input reserved even though the
    // restored claim's owner is gone: the node may hold the transaction. The
    // bytes went with the page, so the claim is consumed into a recent spend
    // that lifecycle probes settle, rather than held until a restart.
    probeGone()
    reject(networkError())
    await expect(attempt).resolves.toMatchObject({ success: false, outcome: 'unknown' })
    await disconnected
    await expectInputSpentNotClaimed()

    // The claim was decided, so it is never restored again: a page still
    // presenting it is probed, and nothing goes back on the wire.
    probeGone()
    await expect(
      wallet.runForUiPort('tab:3', () =>
        wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
      )
    ).resolves.toMatchObject({ success: false, outcome: 'unknown', lookup: 'gone' })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    await expectInputSpentNotClaimed()
  })
})

describe('WalletController.broadcastQbitTx for a fee bump (#340)', () => {
  const REGTEST = ChainType.QBIT_REGTEST
  const reservedKeys = () => qbitSendGuardService.getReservedOutpointKeys(REGTEST, fixture.address)
  const buildingAccount = {
    type: KeyringType.QbitHdKeyring,
    address: fixture.address,
    pubkey: fixture.pubkeyHex,
    key: 'account-0',
    flag: 0,
    index: 0,
  }
  /** What `createBumpFeeQbitPsbt` hands the confirm screen for a bump of the fixture. */
  const feeBump = {
    originalTxid: fixture.txid,
    originalOutputCount: 1,
    originalFee: 10_000,
    replacementFee: 11_000,
    feeDelta: 1_000,
    originalFeeRate: 2,
    replacementFeeRate: 2.2,
    replacementVsize: 5_000,
    changeBefore: 0,
    changeAfter: 0,
    changeDropped: false,
  }
  /** A payment spending the original's output. */
  const laterTxid = 'cc'.repeat(32)
  const dependentDetail = 'A later payment depends on the transaction this fee bump replaces'
  const notActiveDetail = 'Qbit send broadcast claim is not active'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(REGTEST)
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    qbitSendGuardService.init()
  })

  afterEach(() => {
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    qbitSendGuardService.init()
  })

  /**
   * Send the fixture, then sign `otherFixture` as a fee bump of it while
   * nothing spends the original's output, as the confirm screen does.
   */
  async function sendThenSignBump(wallet: WalletController) {
    const original = await signWalletSend(wallet)
    broadcastTxMock.mockResolvedValueOnce(fixture.txid)
    await expect(
      wallet.broadcastQbitTx(
        original.psbtHex!,
        original.qbitSendBroadcastClaim,
        REGTEST,
        fixture.txid
      )
    ).resolves.toMatchObject({ success: true })
    const bump = await signWalletSend(wallet, otherFixture, { feeBump })
    return { psbtHex: bump.psbtHex!, claim: bump.qbitSendBroadcastClaim! }
  }

  type SignedBump = Awaited<ReturnType<typeof sendThenSignBump>>

  /** Broadcast the retained bump as the confirm and recovery screens do. */
  const broadcastBump = (wallet: WalletController, bump: SignedBump) =>
    wallet.broadcastQbitTx(bump.psbtHex, bump.claim, REGTEST, otherFixture.txid)

  /** Lose the bump's first broadcast (unknown verdict), then restart the worker. */
  async function loseBumpThenRestart(wallet: WalletController, bump: SignedBump) {
    explorerShowsOriginal()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      reason: 'network',
    })
    qbitSendGuardService.init()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)
  }

  it('refuses to dispatch a fee bump once the explorer shows a payment spending its original, and keeps it retryable', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)

    // While the confirm screen was open, another wallet on the same seed
    // spent the original's output. Only the explorer can show it. The bump
    // itself is looked up, in case an earlier dispatch went through.
    explorerShowsOriginal([laterTxid])
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toEqual({
      success: false,
      chain: REGTEST,
      txid: otherFixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: dependentDetail,
    })
    expect(getTxOutspendsMock).toHaveBeenCalledWith(fixture.txid, {
      deadlineMs: QBIT_FEE_BUMP_RECHECK_WAIT_MS,
      signal: expect.any(AbortSignal),
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
    // Nothing went out, and the bump's claim still holds the original's
    // input for a retry or until the user abandons it.
    await expect(reservedKeys()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(
      qbitSendGuardService.assertNoOverlap(REGTEST, [{ txid: SOURCE_TXID, vout: 0 }])
    ).rejects.toThrow('claimed by an approved send')

    // An explorer that cannot say refuses it as well.
    getTxOutspendsMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail:
        'Could not check whether a later payment depends on the transaction this fee bump replaces',
    })
    // So does an answer that is not one entry per output of the original.
    explorerShowsOriginal([undefined, undefined])
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)

    // Once nothing spends the original, the same bytes go out unsigned again.
    explorerShowsOriginal()
    broadcastTxMock.mockResolvedValueOnce(otherFixture.txid)
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      success: true,
      txid: otherFixture.txid,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenLastCalledWith(otherFixture.rawTxHex)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(2)
    // The page keeps the original's txid and output count with the bytes,
    // for a retry after a restart, and no broadcast read the original's
    // bytes again.
    expect(bump.claim.replaces).toBe(fixture.txid)
    expect(bump.claim.replacedOutputCount).toBe(1)
    expect(getTxHexMock).not.toHaveBeenCalled()
  })

  it("broadcasts a fee bump without reading its original's bytes again, however slowly they would arrive", async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)

    // On a slow link the raw bytes of an original with many inputs take
    // longer than the check may hold the send guard. The assessment read
    // them before the bump was signed; the broadcast only asks what spends
    // the original's outputs, a small reply.
    getTxHexMock.mockImplementation(() => new Promise(() => undefined))
    explorerShowsOriginal()
    broadcastTxMock.mockResolvedValueOnce(otherFixture.txid)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const outcome = broadcastBump(wallet, bump)
      await vi.advanceTimersByTimeAsync(QBIT_FEE_BUMP_RECHECK_WAIT_MS)
      await expect(outcome).resolves.toEqual({
        success: true,
        chain: REGTEST,
        txid: otherFixture.txid,
        via: 'broadcast',
      })
    } finally {
      vi.useRealTimers()
    }
    expect(getTxHexMock).not.toHaveBeenCalled()
    expect(getTxOutspendsMock).toHaveBeenCalledTimes(1)
    expect(broadcastTxMock).toHaveBeenLastCalledWith(otherFixture.rawTxHex)
    await expectInputSpentNotClaimed()
  })

  it('after a restart, never restores a fee bump whose original a later send of this wallet spends', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)
    await loseBumpThenRestart(wallet, bump)

    // A send from the original's change goes out after the restart.
    const later: QbitSendBroadcastClaim = {
      chain: REGTEST,
      address: fixture.address,
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: laterTxid,
      outpoints: [{ txid: fixture.txid, vout: 0 }],
      replaces: null,
    }
    await qbitSendGuardService.runWithBroadcastClaim(later, async () => 'signed')
    await qbitSendGuardService.broadcastIfAllowed(
      REGTEST,
      laterTxid,
      later.outpoints,
      async () => laterTxid,
      later
    )

    // The retry finds the claim gone and the bump absent. Restoring it would
    // let the bump evict that send, so nothing is dispatched.
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toEqual({
      success: false,
      chain: REGTEST,
      txid: otherFixture.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: notActiveDetail,
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
  })

  it('after a restart, checks the explorer again before dispatching a restored fee bump', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)
    await loseBumpThenRestart(wallet, bump)

    // The claim is restored, but a payment made elsewhere now spends the
    // original's output: the bump is refused before dispatch.
    probeGone()
    explorerShowsOriginal([laterTxid])
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toEqual({
      success: false,
      chain: REGTEST,
      txid: otherFixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: dependentDetail,
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
    await expect(reservedKeys()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))

    // The restored claim is held now: once nothing spends the original, the
    // next retry dispatches without another probe or signature.
    explorerShowsOriginal()
    broadcastTxMock.mockResolvedValueOnce(otherFixture.txid)
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      success: true,
      via: 'broadcast',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(3)
    expect(getTxStatusMock).toHaveBeenCalledTimes(3)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(2)
  })

  it('checks the explorer before pushTx broadcasts a fee bump under its claim', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)

    explorerShowsOriginal([laterTxid])
    await expect(wallet.pushTx(bump.psbtHex, bump.claim)).rejects.toThrow(dependentDetail)
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)

    explorerShowsOriginal()
    broadcastTxMock.mockResolvedValueOnce(otherFixture.txid)
    await expect(wallet.pushTx(bump.psbtHex, bump.claim)).resolves.toBe(otherFixture.txid)
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
  })

  it('reports a retried fee bump the node already took as the success its first answer lost', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)
    explorerShowsOriginal()
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(broadcastBump(wallet, bump)).resolves.toMatchObject({
      outcome: 'unknown',
      reason: 'network',
    })

    // The bump went out after all and replaced its original, which the
    // explorer no longer serves: the check cannot pass, but the lookup of
    // the bump finds it, and nothing is dispatched again.
    getTxOutspendsMock.mockRejectedValueOnce(notFound())
    getTxStatusMock.mockResolvedValueOnce({ confirmed: false })
    getTxMock.mockResolvedValueOnce({ txid: otherFixture.txid })
    await expect(broadcastBump(wallet, bump)).resolves.toEqual({
      success: true,
      chain: REGTEST,
      txid: otherFixture.txid,
      via: 'lookup',
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(2)
    await expectInputSpentNotClaimed()
  })

  it('never signs, restores or broadcasts a fee bump without its original output count', async () => {
    const wallet = newController()
    const bump = await sendThenSignBump(wallet)
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(2)

    // Details without the count the assessment took from the original's
    // bytes: refused before a signature is spent on them.
    const { originalOutputCount: _count, ...uncounted } = feeBump
    await expect(
      signWalletSend(wallet, otherFixture, { feeBump: uncounted as typeof feeBump })
    ).rejects.toThrow('invalid Qbit send broadcast claim')
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(2)
    // The signature that request queued was never asked for.
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockReset()

    // After a restart, a page presenting the bump's claim without the count
    // gets nothing restored, read or sent: its broadcast could only check
    // the original by reading its bytes again.
    qbitSendGuardService.init()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)
    const { replacedOutputCount: _held, ...claim } = bump.claim
    await expect(
      wallet.broadcastQbitTx(bump.psbtHex, claim, REGTEST, otherFixture.txid)
    ).resolves.toMatchObject({
      success: false,
      txid: otherFixture.txid,
      outcome: 'not_sent',
      reason: 'guard_blocked',
      detail: 'invalid Qbit send broadcast claim',
    })
    expect(getTxOutspendsMock).not.toHaveBeenCalled()
    expect(getTxHexMock).not.toHaveBeenCalled()
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
  })

  it('never restores a claim that does not say what its transaction replaces', async () => {
    // A page holding a claim minted before claims carried `replaces`. It
    // may be a fee bump, so it is never restored as a plain send.
    const wallet = newController()
    const signedData = await signWalletSend(wallet)
    const unlabelled: QbitSendBroadcastClaim = { ...signedData.qbitSendBroadcastClaim! }
    delete unlabelled.replaces
    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, unlabelled, REGTEST, fixture.txid)
    ).resolves.toMatchObject({ outcome: 'unknown', reason: 'network' })
    qbitSendGuardService.init()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(buildingAccount as any)

    probeGone()
    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, unlabelled, REGTEST, fixture.txid)
    ).resolves.toEqual({
      success: false,
      chain: REGTEST,
      txid: fixture.txid,
      outcome: 'unknown',
      reason: 'guard_blocked',
      lookup: 'gone',
      detail: notActiveDetail,
    })
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
  })
})

describe('WalletController send claims owned by a UI port', () => {
  const reservedKeys = () =>
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
  const reserved = new Set([`${SOURCE_TXID}:0`])

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    await qbitSendGuardService.resetAllData()
  })

  it('releases a wallet-built send whose signed bytes were lost with the popup that requested them', async () => {
    const wallet = newController()

    // The popup asks for the signature and closes before the answer lands:
    // the bytes exist nowhere, but the claim minted at signing reserves the
    // input until something releases it.
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    expect(signedData.qbitSendBroadcastClaim).toMatchObject({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN })
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // Some other page closing changes nothing.
    await wallet.onUiPortDisconnected('tab:7')
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // The requesting port disconnecting is the owner of last resort.
    await wallet.onUiPortDisconnected('popup:1')
    await expect(reservedKeys()).resolves.toEqual(new Set())
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).toHaveBeenCalledTimes(1)
  })

  it('releases an externally signed send the same way once its signer page is gone', async () => {
    const wallet = newController()

    await wallet.runForUiPort('tab:3', () => reserveExternalWalletSend(wallet))
    await expect(reservedKeys()).resolves.toEqual(reserved)

    await wallet.onUiPortDisconnected('tab:3')
    await expect(reservedKeys()).resolves.toEqual(new Set())
  })

  it('owns nothing for a send signed outside a UI port', async () => {
    const wallet = newController()

    await signWalletSend(wallet)
    await wallet.onUiPortDisconnected('popup:1')
    await expect(reservedKeys()).resolves.toEqual(reserved)
  })

  it('lets an in-flight broadcast decide when its page closes mid-flight', async () => {
    const wallet = newController()
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    const claim = signedData.qbitSendBroadcastClaim!

    // The node accepts, but the popup is gone before the answer: the claim
    // was consumed by the accepted broadcast, and there is nothing to release.
    // The guard queue holds every other operation behind the in-flight
    // broadcast, so the disconnect is observed only once the node answers.
    let deliver: (value: string) => void = () => undefined
    broadcastTxMock.mockReturnValueOnce(new Promise<string>(resolve => (deliver = resolve)))
    const accepted = wallet.runForUiPort('popup:1', () =>
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    )
    const disconnected = wallet.onUiPortDisconnected('popup:1')
    deliver(fixture.txid)
    await expect(accepted).resolves.toMatchObject({ success: true, via: 'broadcast' })
    await disconnected
    await expectInputSpentNotClaimed()
    expect(broadcastTxMock).toHaveBeenCalledTimes(1)
  })

  it('releases after a proven rejection that lands on a page that already closed', async () => {
    const wallet = newController()
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    const claim = signedData.qbitSendBroadcastClaim!

    let reject: (error: unknown) => void = () => undefined
    broadcastTxMock.mockReturnValueOnce(new Promise<string>((_, fail) => (reject = fail)))
    // The absence probes run outside the guard queue and after the
    // disconnect has been observed; make them wait so the release can be
    // seen to defer to the verdict rather than fire on the disconnect.
    let probe: () => void = () => undefined
    getTxStatusMock.mockReturnValueOnce(new Promise((_, fail) => (probe = () => fail(notFound()))))
    for (let index = 1; index < QBIT_BROADCAST_ABSENCE_PROBES; index += 1) probeGone()
    const attempt = wallet.runForUiPort('popup:1', () =>
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    )
    const disconnected = wallet.onUiPortDisconnected('popup:1')
    reject(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    await disconnected
    // The verdict is still being decided: the disconnect released nothing.
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // Nobody is left to abandon this not_sent verdict, so the guard does.
    probe()
    await expect(attempt).resolves.toMatchObject({ success: false, outcome: 'not_sent' })
    await expect(reservedKeys()).resolves.toEqual(new Set())
  })

  it('keeps a claim reserved when the page closes on an inconclusive broadcast', async () => {
    const wallet = newController()
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    const claim = signedData.qbitSendBroadcastClaim!

    broadcastTxMock.mockRejectedValueOnce(networkError())
    probeGone()
    await expect(
      wallet.runForUiPort('popup:1', () =>
        wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
      )
    ).resolves.toMatchObject({ success: false, outcome: 'unknown' })

    // The transaction may be in the node's hands; the inputs stay reserved
    // exactly as they would had the recovery screen been left on `unknown`.
    await wallet.onUiPortDisconnected('popup:1')
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // A status check from a new page that finds it consumes the claim as
    // before.
    probePending()
    await expect(
      wallet.checkQbitBroadcastStatus(claim.txid, ChainType.QBIT_REGTEST, claim)
    ).resolves.toMatchObject({ found: true })
    await expectInputSpentNotClaimed()
  })

  it('keeps a claim while its page is open after a proven rejection, for the retry it may still make', async () => {
    const wallet = newController()
    const signedData = await wallet.runForUiPort('popup:1', () => signWalletSend(wallet))
    const claim = signedData.qbitSendBroadcastClaim!

    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()
    await expect(
      wallet.runForUiPort('popup:1', () =>
        wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
      )
    ).resolves.toMatchObject({ success: false, outcome: 'not_sent' })
    await expect(reservedKeys()).resolves.toEqual(reserved)

    // The recovery screen is still up; leaving it releases the claim, and
    // the port closing without that message reaching the background does
    // the same.
    await wallet.onUiPortDisconnected('popup:1')
    await expect(reservedKeys()).resolves.toEqual(new Set())
  })

  it('restores the calling port after each call, including one that throws synchronously', () => {
    const wallet = newController()
    const failure = new Error('boom')

    expect(
      wallet.runForUiPort('popup:1', () =>
        wallet.runForUiPort('tab:2', () => (wallet as any).callingUiPort)
      )
    ).toBe('tab:2')
    expect(() =>
      wallet.runForUiPort('popup:1', () => {
        throw failure
      })
    ).toThrow(failure)
    expect((wallet as any).callingUiPort).toBeUndefined()
  })
})

describe('WalletController.reserveExternallySignedQbitSend', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    broadcastTxMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  afterEach(async () => {
    await qbitSendGuardService.resetAllData()
  })

  const reserved = () =>
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)

  it.each([KeyringType.ReadonlyKeyring, KeyringType.ColdWalletKeyring])(
    'reserves a wallet-built send signed by a %s account from its signed bytes until the broadcast is proven',
    async keyringType => {
      const wallet = newController()

      const signedData = await reserveExternalWalletSend(wallet, fixture.psbtHex, keyringType)

      // The bytes come back untouched, with the identity fixed at creation
      // and the same wallet-owned claim a local signer's result carries; no
      // signature was requested from the keyring.
      expect(signedData).toEqual({
        psbtHex: fixture.psbtHex,
        qbitBroadcastIdentity: { chain: ChainType.QBIT_REGTEST, txid: fixture.txid },
        qbitSendBroadcastClaim: walletClaim(),
      })
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
      const claim = signedData.qbitSendBroadcastClaim!

      // From here on no other send flow sees the input, signs over it, or
      // broadcasts a conflicting transaction, and the same send cannot be
      // reserved twice.
      await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, claim.outpoints)
      ).rejects.toThrow('claimed by an approved send')
      await expect(
        wallet.broadcastQbitTx(
          otherFixture.psbtHex,
          undefined,
          ChainType.QBIT_REGTEST,
          otherFixture.txid
        )
      ).resolves.toMatchObject({ success: false, outcome: 'not_sent', reason: 'guard_blocked' })
      await expect(reserveExternalWalletSend(wallet, fixture.psbtHex, keyringType)).rejects.toThrow(
        'Qbit send broadcast claim already exists'
      )
      expect(broadcastTxMock).not.toHaveBeenCalled()

      // An ambiguous broadcast keeps the reservation while the exact bytes
      // are still retryable; a lookup that proves acceptance consumes it.
      broadcastTxMock.mockRejectedValueOnce(networkError())
      probeGone()
      await expect(
        wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
      ).resolves.toMatchObject({ success: false, outcome: 'unknown' })
      expect(broadcastTxMock).toHaveBeenCalledWith(fixture.rawTxHex)
      await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
      probePending()
      await expect(
        wallet.checkQbitBroadcastStatus(claim.txid, ChainType.QBIT_REGTEST, claim)
      ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
      await expectInputSpentNotClaimed()
    }
  )

  it.each([KeyringType.ReadonlyKeyring, KeyringType.ColdWalletKeyring])(
    'refuses bytes for a send built for another %s account than the one now selected, until it is selected again',
    async keyringType => {
      const wallet = newController()
      // Another window selected a different account, one that also signs
      // outside the wallet, while the signer was working on the request
      // built for the fixture account. The bytes are still the approved
      // transaction, so only the account tells this request apart.
      const otherPubkey = '22'.repeat(32)
      const other = {
        address: p2mrAddressFromPubkey(hexToBytes(otherPubkey), 'regtest'),
        pubkey: otherPubkey,
      }

      await expect(
        reserveExternalWalletSend(wallet, fixture.psbtHex, keyringType, {}, other)
      ).rejects.toThrow('Qbit account changed since the transaction was created')

      // A claim filed under the other account's address would have kept the
      // input on offer to the building account's send flow; nothing is
      // filed under either address, and no signature was requested.
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(
        qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, other.address)
      ).resolves.toEqual(new Set())
      await expect(
        qbitSendGuardService.assertNoOverlap(ChainType.QBIT_REGTEST, [
          { txid: SOURCE_TXID, vout: 0 },
        ])
      ).resolves.toBeUndefined()
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()

      // Selecting the account the send was built for again reserves the
      // same bytes under its own address, as a network switched back does.
      const signedData = await reserveExternalWalletSend(wallet, fixture.psbtHex, keyringType)
      expect(signedData.qbitSendBroadcastClaim).toEqual(walletClaim())
      await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    }
  )

  it('registers nothing for bytes that are not the approved transaction or for a request it does not own', async () => {
    const wallet = newController()

    // Valid bytes, but for another transaction than the one the wallet
    // built: what a wrong paste or scan hands back.
    await expect(reserveExternalWalletSend(wallet, otherFixture.psbtHex)).rejects.toThrow(
      'signed transaction does not match the approved transaction'
    )
    await expect(reserveExternalWalletSend(wallet, 'not-a-transaction')).rejects.toThrow()
    // A local account reserves inside signPsbtV2, a provider request is
    // locked at approval, and a request whose creation network is no longer
    // the active one is refused exactly as local signing refuses it.
    await expect(
      reserveExternalWalletSend(wallet, fixture.psbtHex, KeyringType.QbitHdKeyring)
    ).rejects.toThrow('invalid externally signed Qbit send')
    await expect(
      reserveExternalWalletSend(wallet, fixture.psbtHex, KeyringType.ReadonlyKeyring, {
        providerContext: {
          origin: 'https://dapp.example',
          account: fixture.address,
          chain: ChainType.QBIT_REGTEST,
          network: 'regtest',
        },
      })
    ).rejects.toThrow('invalid externally signed Qbit send')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    await expect(reserveExternalWalletSend(wallet)).rejects.toThrow(
      'Qbit network changed since the transaction was created'
    )
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    await expect(reserved()).resolves.toEqual(new Set())

    // An input another approved send already claims is refused before
    // anything is registered, as at local signing.
    await qbitSendGuardService.runWithBroadcastClaim(claimFor('ee'.repeat(32)), async () => 'ok')
    await expect(reserveExternalWalletSend(wallet)).rejects.toThrow('claimed by an approved send')
    await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    expect(broadcastTxMock).not.toHaveBeenCalled()
    expect(getTxStatusMock).not.toHaveBeenCalled()
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
  })

  it('releases an externally signed send only through its exact claim after a proven rejection', async () => {
    const wallet = newController()
    const signedData = await reserveExternalWalletSend(wallet)
    const claim = signedData.qbitSendBroadcastClaim!
    broadcastTxMock.mockRejectedValueOnce(
      rejection(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    for (let probe = 0; probe < QBIT_BROADCAST_ABSENCE_PROBES; probe += 1) probeGone()

    await expect(
      wallet.broadcastQbitTx(signedData.psbtHex!, claim, claim.chain, claim.txid)
    ).resolves.toMatchObject({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: fixture.txid,
      outcome: 'not_sent',
      reason: 'rejected',
    })

    // Still reserved while the recovery screen can retry the bytes; leaving
    // that screen releases it through the same exact-match release.
    await expect(reserved()).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
    await expect(wallet.releaseQbitSendBroadcastClaim(claim)).resolves.toBe(true)
    await expect(reserved()).resolves.toEqual(new Set())
  })
})

describe('WalletController.checkQbitBroadcastStatus', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_REGTEST)
    getTxStatusMock.mockReset()
    getTxMock.mockReset()
    getTxHexMock.mockReset()
    getTxOutspendsMock.mockReset()
    await qbitSendGuardService.resetAllData()
  })

  it('finds a pending or confirmed transaction', async () => {
    const wallet = newController()
    probePending()
    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid.toUpperCase(), ChainType.QBIT_REGTEST)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })

    getTxStatusMock.mockResolvedValueOnce({ confirmed: true })
    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'confirmed' })
  })

  it('reports absence and lookup failures as plain values', async () => {
    const wallet = newController()
    probeGone()
    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST)
    ).resolves.toEqual({ found: false, txid: fixture.txid, state: 'gone' })

    getTxStatusMock.mockRejectedValueOnce(networkError())
    const unavailable = await wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST)
    expect(unavailable).toEqual({
      found: false,
      txid: fixture.txid,
      state: 'unavailable',
      detail: 'network error: [url] (TypeError: fetch failed)',
    })
  })

  it('refuses malformed txids and a network that no longer matches', async () => {
    const wallet = newController()
    await expect(wallet.checkQbitBroadcastStatus('nope', ChainType.QBIT_REGTEST)).resolves.toEqual({
      found: false,
      txid: 'nope',
      state: 'unavailable',
      detail: 'invalid txid',
    })
    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_MAINNET)
    ).resolves.toMatchObject({ found: false, state: 'unavailable' })
    expect(getTxStatusMock).not.toHaveBeenCalled()
  })

  it('consumes the send claim once the transaction is found', async () => {
    const wallet = newController()
    const claim = claimFor()
    await qbitSendGuardService.runWithBroadcastClaim(claim, async () => 'signed')
    probePending()

    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid.toUpperCase(), ChainType.QBIT_REGTEST, claim)
    ).resolves.toMatchObject({ found: true })
    await expectInputSpentNotClaimed()
  })

  it('keeps a claim for another transaction active when a different txid is found', async () => {
    const wallet = newController()
    const otherClaim = claimFor('ee'.repeat(32))
    await qbitSendGuardService.runWithBroadcastClaim(otherClaim, async () => 'signed')
    probePending()

    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST, otherClaim)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
  })

  it('keeps a claim for another network active when the txid is found on the current one', async () => {
    const wallet = newController()
    const mainnetClaim: QbitSendBroadcastClaim = { ...claimFor(), chain: ChainType.QBIT_MAINNET }
    await qbitSendGuardService.runWithBroadcastClaim(mainnetClaim, async () => 'signed')
    probePending()

    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST, mainnetClaim)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
    await expect(
      qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_MAINNET, fixture.address)
    ).resolves.toEqual(new Set([`${SOURCE_TXID}:0`]))
  })

  it('ignores a malformed claim instead of failing the status check', async () => {
    const wallet = newController()
    probePending()

    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST, {
        chain: ChainType.QBIT_REGTEST,
      } as unknown as QbitSendBroadcastClaim)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
  })

  it('looks the transaction up on the captured network even if the wallet switches mid-check', async () => {
    const wallet = newController()
    getTxStatusMock.mockImplementationOnce(async () => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
      return { confirmed: false }
    })
    getTxMock.mockResolvedValueOnce({ txid: fixture.txid })

    await expect(
      wallet.checkQbitBroadcastStatus(fixture.txid, ChainType.QBIT_REGTEST)
    ).resolves.toEqual({ found: true, txid: fixture.txid, state: 'pending' })
    expect(apiClientMock.mock.calls.map(([options]) => options)).toEqual([
      {
        baseUrl: REGTEST_ENDPOINT,
        timeoutMs: QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
        fetchFn: expect.any(Function),
      },
    ])
  })
})
