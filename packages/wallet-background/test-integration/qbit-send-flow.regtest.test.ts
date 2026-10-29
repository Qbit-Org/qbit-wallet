/**
 * F4 send-flow end-to-end proof against the real regtest harness (#30).
 *
 * Drives the actual WalletController build path (createSendQbitPsbt), the
 * counter-safe keyring signing path (signP2mrPsbtWithCounter through a real
 * KeyringService), and the qbit Esplora broadcast path (pushTx) against live
 * qbitd + electrs-qbit, and proves:
 *
 *  1. The previewed fee (ToSignData.estimatedFee, which the confirm screen
 *     renders via analyzeLocalPsbts) equals the fee actually paid by the
 *     mined transaction.
 *  2. RBF: inputs carry the BIP125 sequence and a higher-fee replacement
 *     built from the live original by the production fee-bump path evicts it,
 *     preserves intent, and reports the exact fee delta and lifecycle.
 *  3. Immature coinbase outputs (confirmations < QBIT_COINBASE_MATURITY) are
 *     excluded from wallet UTXO selection and spendable balance while qbitd
 *     still rejects spending them, and become spendable at exactly the
 *     consensus maturity boundary.
 *  4. Broadcast recovery (#232): a signed transaction whose broadcast fails
 *     is rebroadcast byte-for-byte from the retained payload without
 *     re-signing, lands on the same txid, and never advances the P2MR
 *     signature counter. The outage and the lost-response boundary are
 *     simulated at the API client's broadcast method (the harness offers no
 *     supported way to partition electrs from the test), so qbitd's live
 *     duplicate-submission behaviour is exercised only through the
 *     call-through lost-response seam.
 *
 * Requires the regtest harness (`pnpm regtest:up`). Skips when the harness is
 * unreachable unless QBIT_REGTEST_REQUIRED=1 (as in conformance CI).
 *
 * The suite assumes it is the only harness user while it runs: the compose
 * project pins fixed host ports, and test 3 asserts exact confirmation depths,
 * so a concurrent miner or reset (e.g. another workspace) will fail the run.
 * Fresh per-run mnemonics only isolate addresses, not chain height.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

import { init as initPqc, keygen, constants as pqcConstants } from '@qbit-oss/pqc'
import {
  QBIT_COINBASE_MATURITY,
  bytesToHex,
  decodePsbt,
  extractP2mrTransaction,
  hexToBytes,
  p2mrAddressFromPubkey,
  parsePsbt,
} from '@qbit-oss/protocol'
import { EsploraClient, QbitApiError } from '@qbit-oss/api'
import { KeyringService } from '@qbit/keyring-service'
import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, CHAINS_MAP } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import type { Encryptor } from '@qbit/keyring-service'
import { bgEventBus } from '../src/utils/eventBus'
import { qbitExplorerSpendCheckFor } from '../src/utils/qbit-explorer-spend-check'

const serviceHolder = vi.hoisted(() => ({
  keyringService: undefined as any,
  currentAccount: undefined as any,
}))

vi.mock('../src/services', () => ({
  keyringService: new Proxy(
    {},
    {
      get(_target, prop) {
        const service = serviceHolder.keyringService
        if (!service) throw new Error('keyringService not initialised yet')
        const value = service[prop]
        return typeof value === 'function' ? value.bind(service) : value
      },
    }
  ),
  preferenceService: {
    getCurrentAccount: () => serviceHolder.currentAccount,
    getCurrentKeyringIndex: () => 0,
    getAccountAlianName: (_key: string, defaultName: string) => defaultName,
    getKeyringAlianName: (_key: string, defaultName: string) => defaultName,
    getAddressFlag: () => 0,
    getChainType: () => ChainType.QBIT_REGTEST,
  },
  walletApiService: {
  },
  sessionService: {},
  contactBookService: {},
  notificationService: {},
  permissionService: {},
  qbitSendGuardService: {
    getReservedOutpointKeys: async () => new Set<string>(),
    // The wallet's own record of later spends stays empty here, so a fee
    // bump's descendant check rests on what electrs reports.
    hasDependentSpend: async () => false,
    takeRecentSpendersToProbe: async () => [],
    settleRecentSpendProbe: async () => undefined,
    recordAcceptedBroadcast: async () => undefined,
    recordInconclusiveBroadcast: async () => undefined,
    hasUnknownBroadcastOutcome: async () => false,
    forgetProvenAbsentBroadcast: async () => true,
    consumeBroadcastClaim: async () => false,
    observePendingSpender: async () => undefined,
    assertNoOverlap: async () => undefined,
    runWithNoOverlap: async <T>(
      _chain: ChainType,
      _outpoints: readonly unknown[],
      operation: () => Promise<T>
    ) => operation(),
    runWithBroadcastClaim: async <T>(_claim: unknown, operation: () => Promise<T>) => operation(),
    // Every broadcast here runs under no claim, so it gets the check the real
    // guard builds for one: nothing to check.
    broadcastIfAllowed: async <T>(
      _chain: ChainType,
      txid: string,
      outpoints: readonly { txid: string; vout: number }[],
      broadcast: (spendCheck: ReturnType<typeof qbitExplorerSpendCheckFor>) => Promise<T>
    ) => broadcast(qbitExplorerSpendCheckFor({ txid, outpoints })),
  },
}))

vi.mock('../src/services/approval', () => ({ default: {} }))

const RPC_HOST = process.env.QBIT_REGTEST_RPC_HOST || '127.0.0.1'
const RPC_PORT = Number(process.env.QBIT_REGTEST_RPC_PORT || 18452)
const RPC_USER = process.env.QBIT_REGTEST_RPC_USER || 'qbit'
const RPC_PASSWORD = process.env.QBIT_REGTEST_RPC_PASSWORD || 'qbit'
// The WalletController talks to the QBIT_REGTEST chain endpoint from
// CHAINS_MAP (http://127.0.0.1:3002), so the harness must run on defaults.
const ELECTRS_URL = process.env.QBIT_REGTEST_ELECTRS_HTTP_URL || 'http://127.0.0.1:3002'
const FUNDING_WALLET = process.env.QBIT_FUNDING_WALLET || 'qbit-funding'
const HARNESS_REQUIRED = process.env.QBIT_REGTEST_REQUIRED === '1'

const RBF_SEQUENCE = 0xfffffffd

async function rpc<T = any>(
  method: string,
  params: unknown[] = [],
  walletName?: string,
  timeoutMs = 240_000
): Promise<T> {
  const path = walletName ? `/wallet/${encodeURIComponent(walletName)}` : '/'
  let response: Response
  try {
    // Explicit timeout: wallet RPCs can stall for minutes while qbitd digests
    // large generatetoaddress batches, and undici's default headers timeout
    // (300s) otherwise surfaces as an opaque "fetch failed".
    response = await fetch(`http://${RPC_HOST}:${RPC_PORT}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'qbit-send-flow', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error: any) {
    throw new Error(
      `RPC ${method}${walletName ? ` (wallet ${walletName})` : ''} did not respond within ` +
        `${timeoutMs / 1000}s or the connection failed: ${error?.cause?.code ?? error?.name ?? error}`
    )
  }
  const payload: any = await response.json().catch(() => undefined)
  if (!payload || payload.error) {
    throw new Error(
      `RPC ${method} failed: ${payload?.error ? JSON.stringify(payload.error) : response.status}`
    )
  }
  return payload.result as T
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 120_000,
  intervalMs = 1_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    const value = await probe().catch(error => {
      lastError = error
      return undefined
    })
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

async function ensureCoreWallet(name: string): Promise<void> {
  try {
    await rpc('createwallet', [name])
    return
  } catch {
    // Wallet may already exist (possibly unloaded); fall through to loadwallet.
  }
  try {
    await rpc('loadwallet', [name])
  } catch (error: any) {
    if (!/already loaded/i.test(String(error?.message))) throw error
  }
}

async function mineBlocks(count: number, address: string): Promise<string[]> {
  const hashes: string[] = []
  // Small chunks keep each generatetoaddress call well under the RPC timeout
  // even when block templating slows down on chains dense with SLH-DSA
  // coinbases, and give qbitd's wallet a chance to service other RPCs.
  let remaining = count
  while (remaining > 0) {
    const chunk = Math.min(remaining, 150)
    hashes.push(...(await rpc<string[]>('generatetoaddress', [chunk, address])))
    remaining -= chunk
  }
  return hashes
}

async function waitForElectrsHeight(client: EsploraClient, height: number): Promise<void> {
  await waitFor(
    `electrs tip >= ${height}`,
    async () => ((await client.getTipHeight()) >= height ? true : undefined),
    180_000
  )
}

/** Fee actually paid by a mined tx, computed from Core prevout values. */
async function minedFee(txid: string): Promise<{ fee: number; tx: any }> {
  const tx = await rpc<any>('getrawtransaction', [txid, true])
  let inputSats = 0
  for (const vin of tx.vin) {
    const prev = await rpc<any>('getrawtransaction', [vin.txid, true])
    inputSats += Math.round(prev.vout[vin.vout].value * 1e8)
  }
  const outputSats = tx.vout.reduce((sum: number, out: any) => sum + Math.round(out.value * 1e8), 0)
  return { fee: inputSats - outputSats, tx }
}

function rawTxFromSignedPsbtHex(psbtHex: string): string {
  return bytesToHex(extractP2mrTransaction(parsePsbt(hexToBytes(psbtHex))))
}

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, value)
  }

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    const stored = (await this.get(name)) || template
    await this.set(name, stored)
    return stored
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function harnessReachable(): Promise<boolean> {
  try {
    await rpc('getblockchaininfo')
    const height = await fetch(`${ELECTRS_URL}/blocks/tip/height`)
    return height.ok
  } catch {
    return false
  }
}

const maturityOverride = process.env.QBIT_REGTEST_COINBASE_MATURITY
if (maturityOverride && Number(maturityOverride) !== QBIT_COINBASE_MATURITY) {
  // qbitd takes no maturity flag: consensus is always QBIT_COINBASE_MATURITY,
  // so a diverging harness override can only desync the funding scripts.
  throw new Error(
    `QBIT_REGTEST_COINBASE_MATURITY=${maturityOverride} conflicts with the ` +
      `consensus constant ${QBIT_COINBASE_MATURITY}; unset it for this suite`
  )
}

const harnessUp = await harnessReachable()
if (!harnessUp) {
  if (HARNESS_REQUIRED) {
    throw new Error('QBIT_REGTEST_REQUIRED=1 but the regtest harness is unreachable')
  }
  console.warn('[qbit-send-flow] regtest harness unreachable; skipping e2e send-flow suite')
}

describe.runIf(harnessUp)('qbit P2MR send flow against regtest (#30 F4)', () => {
  let WalletController: typeof import('../src/controllers/wallet').WalletController
  let getQbitSpendableBalanceV2: typeof import('../src/utils/qbit-api').getQbitSpendableBalanceV2
  let wallet: InstanceType<typeof import('../src/controllers/wallet').WalletController>
  let keyring: any
  let electrs: EsploraClient
  let walletAddress: string
  let walletScriptPk: string
  let walletPubkey: string
  let fundingAddress: string
  let recipient: string

  const fundWalletAddress = async (amountQbt: string): Promise<string> => {
    const txid = await rpc<string>(
      'sendtoaddress',
      [walletAddress, amountQbt],
      FUNDING_WALLET
    )
    await mineBlocks(1, fundingAddress)
    const height = await rpc<number>('getblockcount')
    await waitForElectrsHeight(electrs, height)
    await waitFor(`wallet sees funding utxo ${txid}`, async () => {
      const utxos = await wallet.getQbitUtxos()
      return utxos.some(utxo => utxo.txid === txid) ? true : undefined
    })
    return txid
  }

  const counterCount = async (): Promise<number> => {
    return keyring.getPqcSignatureCounter(walletPubkey)
  }

  beforeAll(async () => {
    // The WalletController always talks to the chain-config endpoint; a
    // diverging electrs override would silently test two different backends.
    const chainEndpoint = CHAINS_MAP[ChainType.QBIT_REGTEST]!.endpoints[0]
    if (ELECTRS_URL !== chainEndpoint) {
      throw new Error(
        `QBIT_REGTEST_ELECTRS_HTTP_URL=${ELECTRS_URL} does not match the wallet's ` +
          `QBIT_REGTEST endpoint ${chainEndpoint}; run the harness on defaults`
      )
    }

    await initPqc()

    // Real keyring service with a fresh random mnemonic per run so repeated
    // local runs never collide on regtest chain state.
    const service = new KeyringService()
    await service.init({
      storage: new MemoryStorage(),
      encryptor: new JsonEncryptor(),
      logger: noopLogger,
      t: (key: string) => key,
    })
    await service.boot('integration-password')
    const mnemonic = service.generateMnemonic(128)
    keyring = await service.createKeyringWithMnemonics(
      mnemonic,
      "m/87'/1'/0'/0",
      '',
      AddressType.P2MR,
      1
    )
    serviceHolder.keyringService = service

    const [account] = await keyring.getQbitAccounts()
    walletAddress = account.addresses.regtest
    walletScriptPk = account.scriptPubKey
    walletPubkey = account.pubkey
    serviceHolder.currentAccount = {
      type: KeyringType.QbitHdKeyring,
      pubkey: account.pubkey,
      address: walletAddress,
      key: 'integration-account-0',
      flag: 0,
      index: 0,
      p2mr: account,
    }

    // Recipient is an unrelated single-key P2MR script.
    const entropy = new Uint8Array(pqcConstants.MIN_ENTROPY)
    webcrypto.getRandomValues(entropy)
    recipient = p2mrAddressFromPubkey(keygen(entropy).publicKey, 'regtest')

    const controllers = await import('../src/controllers/wallet')
    WalletController = controllers.WalletController
    ;({ getQbitSpendableBalanceV2 } = await import('../src/utils/qbit-api'))
    wallet = new WalletController()
    electrs = new EsploraClient({ baseUrl: ELECTRS_URL })

    // Core-side funding wallet with mature coins.
    await ensureCoreWallet(FUNDING_WALLET)
    fundingAddress = await rpc<string>('getnewaddress', [], FUNDING_WALLET)
    const balances = await rpc<any>('getbalances', [], FUNDING_WALLET)
    if ((balances?.mine?.trusted ?? 0) < 1) {
      await mineBlocks(QBIT_COINBASE_MATURITY + 1, fundingAddress)
    }
    const height = await rpc<number>('getblockcount')
    await waitForElectrsHeight(electrs, height)
  }, 600_000)

  it('sends P2MR end to end with the previewed fee equal to the paid fee', async () => {
    await fundWalletAddress('0.005')

    const utxos = await wallet.getQbitUtxos()
    const amount = 120_000
    const feeRate = 2
    const countBefore = await counterCount()

    const toSignData = await wallet.createSendQbitPsbt({
      to: recipient,
      amount,
      feeRate,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: utxos,
    })
    expect(toSignData.estimatedFee).toBeGreaterThan(0)

    // What the confirm screen renders must match what gets signed.
    const summary = await wallet.analyzeLocalPsbts([toSignData])
    expect(summary.parseErrorCount).toBe(0)
    expect(summary.totalFee).toBe(toSignData.estimatedFee)

    const signed = await wallet.signPsbtV2(toSignData)
    expect(await counterCount()).toBe(countBefore + toSignData.toSignInputs.length)

    // Differential gate: qbitd must accept the wallet-built bytes and agree
    // on the fee before we broadcast.
    const rawHex = rawTxFromSignedPsbtHex(signed.psbtHex!)
    const [acceptance] = await rpc<any[]>('testmempoolaccept', [[rawHex]])
    expect(acceptance.allowed, `reject-reason: ${acceptance['reject-reason']}`).toBe(true)
    expect(Math.round(acceptance.fees.base * 1e8)).toBe(toSignData.estimatedFee)

    const txid = await wallet.pushTx(signed.psbtHex!)
    expect(txid).toBe(acceptance.txid)

    await mineBlocks(1, fundingAddress)
    const { fee, tx } = await minedFee(txid)
    expect(tx.confirmations).toBeGreaterThanOrEqual(1)
    expect(fee).toBe(toSignData.estimatedFee)
    for (const vin of tx.vin) {
      expect(vin.sequence).toBe(RBF_SEQUENCE)
    }
    const recipientOutput = tx.vout.find((out: any) => Math.round(out.value * 1e8) === amount)
    expect(recipientOutput).toBeDefined()

    const height = await rpc<number>('getblockcount')
    await waitForElectrsHeight(electrs, height)
    const status = await electrs.getTxStatus(txid)
    expect(status.confirmed).toBe(true)
  }, 600_000)

  it('proves the production fee-bump lifecycle, exact fee delta, preserved intent and counters', async () => {
    const fundTxid = await fundWalletAddress('0.003')
    const fundUtxo = (await wallet.getQbitUtxos()).find(utxo => utxo.txid === fundTxid)
    expect(fundUtxo).toBeDefined()

    const amount = 90_000
    const memo = 'regtest fee-bump lifecycle'
    const countBefore = await counterCount()
    const displayedCounterCounts: number[] = []
    const accountChangeListener = (event: any) => {
      if (
        event?.method === BUS_METHODS.ACCOUNTS_CHANGED &&
        event.params?.address === walletAddress
      ) {
        displayedCounterCounts.push(event.params.p2mr?.signatureCounter?.count)
      }
    }
    bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, accountChangeListener)

    try {
      const original = await wallet.createSendQbitPsbt({
        to: recipient,
        amount,
        feeRate: 1,
        qbitUtxoChain: ChainType.QBIT_REGTEST,
        qbitUtxos: [fundUtxo!],
        enableRBF: true,
        memo,
      })
      const originalSummary = decodePsbt(parsePsbt(hexToBytes(original.psbtHex)))
      const originalSigned = await wallet.signPsbtV2(original)
      const countAfterOriginal = await counterCount()
      expect(countAfterOriginal).toBe(countBefore + original.toSignInputs.length)
      expect(displayedCounterCounts.at(-1)).toBe(countAfterOriginal)

      const originalRawHex = rawTxFromSignedPsbtHex(originalSigned.psbtHex!)
      const [originalAcceptance] = await rpc<any[]>('testmempoolaccept', [[originalRawHex]])
      expect(
        originalAcceptance.allowed,
        `reject-reason: ${originalAcceptance['reject-reason']}`
      ).toBe(true)
      const originalAcceptedFee = Math.round(originalAcceptance.fees.base * 1e8)
      expect(originalAcceptedFee).toBe(original.estimatedFee)

      const originalTxid = await wallet.pushTx(originalSigned.psbtHex!)
      expect(originalTxid).toBe(originalAcceptance.txid)
      await rpc('getmempoolentry', [originalTxid])
      const originalPending = await waitFor('original transaction pending', async () => {
        const lifecycle = await wallet.getQbitTxLifecycleStatus(originalTxid)
        return lifecycle.state === 'pending' ? lifecycle.state : undefined
      })
      expect(originalPending).toBe('pending')

      const eligibility = await waitFor('original transaction fee-bump eligibility', async () => {
        const result = await wallet.getQbitFeeBumpEligibility(originalTxid)
        return result.eligible ? result : undefined
      })
      expect(eligibility.originalFee).toBe(originalAcceptedFee)

      const replacement = await wallet.createBumpFeeQbitPsbt({
        txid: originalTxid,
        feeRate: 5,
      })
      expect(await counterCount()).toBe(countAfterOriginal)
      expect(replacement.feeBump).toBeDefined()
      const feeBump = replacement.feeBump!
      expect(feeBump.originalFee).toBe(originalAcceptedFee)
      expect(feeBump.replacementFee).toBe(replacement.estimatedFee)
      expect(feeBump.feeDelta).toBe(feeBump.replacementFee - feeBump.originalFee)
      expect(feeBump.replacementFee).toBeGreaterThan(feeBump.originalFee)
      expect(feeBump.replacementFeeRate).toBeGreaterThan(feeBump.originalFeeRate)

      const replacementSummary = decodePsbt(parsePsbt(hexToBytes(replacement.psbtHex)))
      const intendedOutputs = (summary: ReturnType<typeof decodePsbt>) =>
        summary.outputs
          .filter(
            output => bytesToHex(output.scriptPubKey).toLowerCase() !== walletScriptPk.toLowerCase()
          )
          .map(output => ({
            value: output.value.toString(),
            scriptPubKey: bytesToHex(output.scriptPubKey),
          }))
      expect(intendedOutputs(replacementSummary)).toEqual(intendedOutputs(originalSummary))

      const originalChange = originalSummary.outputs.find(
        output => bytesToHex(output.scriptPubKey).toLowerCase() === walletScriptPk.toLowerCase()
      )
      const replacementChange = replacementSummary.outputs.find(
        output => bytesToHex(output.scriptPubKey).toLowerCase() === walletScriptPk.toLowerCase()
      )
      expect(Number(originalChange?.value)).toBe(feeBump.changeBefore)
      expect(Number(replacementChange?.value ?? 0n)).toBe(feeBump.changeAfter)

      const replacementSigned = await wallet.signPsbtV2(replacement)
      const countAfterReplacement = await counterCount()
      expect(countAfterReplacement).toBe(countAfterOriginal + replacement.toSignInputs.length)
      expect(displayedCounterCounts.at(-1)).toBe(countAfterReplacement)

      const replacementRawHex = rawTxFromSignedPsbtHex(replacementSigned.psbtHex!)
      expect(replacementRawHex.length / 2).toBe(feeBump.replacementVsize)
      const [replacementAcceptance] = await rpc<any[]>('testmempoolaccept', [[replacementRawHex]])
      expect(
        replacementAcceptance.allowed,
        `reject-reason: ${replacementAcceptance['reject-reason']}`
      ).toBe(true)
      const replacementAcceptedFee = Math.round(replacementAcceptance.fees.base * 1e8)
      expect(replacementAcceptedFee).toBe(feeBump.replacementFee)
      expect(replacementAcceptedFee - originalAcceptedFee).toBe(feeBump.feeDelta)

      const replacementTxid = await wallet.pushTx(replacementSigned.psbtHex!)
      expect(replacementTxid).toBe(replacementAcceptance.txid)
      await rpc('getmempoolentry', [replacementTxid])
      await expect(rpc('getmempoolentry', [originalTxid])).rejects.toThrow(/not in mempool/i)

      const originalGone = await waitFor('original transaction replaced or gone', async () => {
        const lifecycle = await wallet.getQbitTxLifecycleStatus(originalTxid)
        return lifecycle.state === 'gone' ? lifecycle.state : undefined
      })
      const replacementPending = await waitFor('replacement transaction pending', async () => {
        const lifecycle = await wallet.getQbitTxLifecycleStatus(replacementTxid)
        return lifecycle.state === 'pending' ? lifecycle.state : undefined
      })
      expect(originalGone).toBe('gone')
      expect(replacementPending).toBe('pending')

      await mineBlocks(1, fundingAddress)
      const height = await rpc<number>('getblockcount')
      await waitForElectrsHeight(electrs, height)
      const replacementConfirmed = await waitFor('replacement transaction confirmed', async () => {
        const lifecycle = await wallet.getQbitTxLifecycleStatus(replacementTxid)
        return lifecycle.state === 'confirmed' ? lifecycle.state : undefined
      })
      expect(replacementConfirmed).toBe('confirmed')
      await expect(wallet.getQbitTxLifecycleStatus(originalTxid)).resolves.toEqual({
        state: 'gone',
      })

      const { fee, tx } = await minedFee(replacementTxid)
      expect(tx.confirmations).toBeGreaterThanOrEqual(1)
      expect(fee).toBe(feeBump.replacementFee)
      expect(fee - originalAcceptedFee).toBe(feeBump.feeDelta)
      await expect(rpc('getrawtransaction', [originalTxid, true])).rejects.toThrow()

      console.info(
        '[qbit-send-flow][rbf-evidence]',
        JSON.stringify({
          originalTxid,
          replacementTxid,
          lifecycle: [
            'original:pending',
            'original:gone',
            'replacement:pending',
            'replacement:confirmed',
          ],
          originalFee: originalAcceptedFee,
          replacementFee: fee,
          exactFeeDelta: feeBump.feeDelta,
          originalFeeRate: feeBump.originalFeeRate,
          replacementFeeRate: feeBump.replacementFeeRate,
          replacementVsize: feeBump.replacementVsize,
          counterBefore: countBefore,
          counterAfter: countAfterReplacement,
        })
      )
    } finally {
      bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, accountChangeListener)
    }
  }, 600_000)

  it('refuses to bump a payment whose change funded a later payment, leaving both in place (#274)', async () => {
    const fundTxid = await fundWalletAddress('0.003')
    const fundUtxo = (await wallet.getQbitUtxos()).find(utxo => utxo.txid === fundTxid)
    expect(fundUtxo).toBeDefined()

    const first = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 90_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [fundUtxo!],
      enableRBF: true,
    })
    const firstTxid = await wallet.pushTx((await wallet.signPsbtV2(first)).psbtHex!)
    await rpc('getmempoolentry', [firstTxid])

    // The first payment's change is the wallet's own (#279), so the next
    // payment may spend it before it confirms.
    const change = await waitFor('first payment change selectable', async () =>
      (await wallet.getQbitUtxos()).find(utxo => utxo.txid === firstTxid)
    )
    const second = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 50_000,
      feeRate: 1,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [change],
      enableRBF: true,
    })
    const secondTxid = await wallet.pushTx((await wallet.signPsbtV2(second)).psbtHex!)
    await rpc('getmempoolentry', [secondTxid])

    const countBeforeBump = await counterCount()
    const refusal = await waitFor(
      'fee bump refused once electrs indexes the later payment',
      async () => {
        const result = await wallet.getQbitFeeBumpEligibility(firstTxid)
        return result.eligible === false && result.reason === 'has_descendants' ? result : undefined
      }
    )
    expect(refusal).toEqual({ eligible: false, reason: 'has_descendants' })
    // At the Fast tier a priced replacement would cover both fees and evict
    // the second payment; it is never built, and no signature is spent.
    await expect(wallet.createBumpFeeQbitPsbt({ txid: firstTxid, feeRate: 9 })).rejects.toThrow(
      'has_descendants'
    )
    expect(await counterCount()).toBe(countBeforeBump)

    await rpc('getmempoolentry', [firstTxid])
    await rpc('getmempoolentry', [secondTxid])
    await mineBlocks(1, fundingAddress)
    const height = await rpc<number>('getblockcount')
    await waitForElectrsHeight(electrs, height)
    await waitFor('later payment confirmed', async () => {
      const lifecycle = await wallet.getQbitTxLifecycleStatus(secondTxid)
      return lifecycle.state === 'confirmed' ? lifecycle.state : undefined
    })
  }, 600_000)

  it('excludes immature coinbase from selection until consensus maturity', async () => {
    // Mine a block paying the coinbase reward straight to the wallet address.
    const [coinbaseBlockHash] = await mineBlocks(1, walletAddress)
    const coinbaseBlock = await rpc<any>('getblock', [coinbaseBlockHash, 2])
    const coinbaseTx = coinbaseBlock.tx[0]
    const coinbaseVout = coinbaseTx.vout.findIndex(
      (out: any) => out.scriptPubKey?.hex?.toLowerCase() === walletScriptPk.toLowerCase()
    )
    expect(coinbaseVout).toBeGreaterThanOrEqual(0)
    const coinbaseValue = Math.round(coinbaseTx.vout[coinbaseVout].value * 1e8)

    // Land in the regression band: mature under the old (incorrect) 100-block
    // This output remains immature under Qbit's 1,000-block consensus rule.
    await mineBlocks(150, fundingAddress)
    let height = await rpc<number>('getblockcount')
    await waitForElectrsHeight(electrs, height)

    await waitFor(`electrs indexes coinbase utxo ${coinbaseTx.txid}`, async () => {
      const raw = await electrs.getAddressUtxos(walletAddress)
      return raw.some(utxo => utxo.txid === coinbaseTx.txid) ? true : undefined
    })
    const walletUtxos = await wallet.getQbitUtxos()
    expect(walletUtxos.some(utxo => utxo.txid === coinbaseTx.txid)).toBe(false)

    const balance = await getQbitSpendableBalanceV2(electrs, walletAddress, walletScriptPk)
    expect(balance.unavailableBalance).toBeGreaterThanOrEqual(coinbaseValue)

    // Differential proof that the wallet filter matches consensus: force the
    // immature coinbase through the wallet build/sign path and let qbitd
    // reject the premature spend.
    const immatureUtxo = {
      txid: coinbaseTx.txid,
      vout: coinbaseVout,
      satoshis: coinbaseValue,
      scriptPk: walletScriptPk,
      pubkey: walletPubkey,
      addressType: AddressType.P2MR,
    } as any
    const countBeforeRejectedSign = await counterCount()
    const immatureSpend = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 1_000_000,
      feeRate: 2,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [immatureUtxo],
    })
    const immatureSigned = await wallet.signPsbtV2(immatureSpend)
    const countAfterRejectedSign = await counterCount()
    expect(countAfterRejectedSign).toBe(countBeforeRejectedSign + immatureSpend.toSignInputs.length)
    const rawHex = rawTxFromSignedPsbtHex(immatureSigned.psbtHex!)
    const [rejected] = await rpc<any[]>('testmempoolaccept', [[rawHex]])
    expect(rejected.allowed).toBe(false)
    expect(String(rejected['reject-reason'])).toMatch(/premature|coinbase/i)

    // An actual broadcast failure occurs after the counter reservation and
    // signature are persisted. It must not roll the counter back or make the
    // stale approval reusable. A fresh preflight sees the cached signature and
    // can safely reproduce the exact bytes without consuming another counter.
    await expect(wallet.pushTx(immatureSigned.psbtHex!)).rejects.toThrow()
    expect(await counterCount()).toBe(countAfterRejectedSign)
    await expect(wallet.signPsbtV2(immatureSpend)).rejects.toThrow(
      'P2MR signature budget changed after approval'
    )
    expect(await counterCount()).toBe(countAfterRejectedSign)

    const retriedSpend = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 1_000_000,
      feeRate: 2,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [immatureUtxo],
    })
    expect(retriedSpend.signatureBudget).toMatchObject({ required: 0, cached: 1 })
    const retriedSigned = await wallet.signPsbtV2(retriedSpend)
    expect(rawTxFromSignedPsbtHex(retriedSigned.psbtHex!)).toBe(rawHex)
    expect(await counterCount()).toBe(countAfterRejectedSign)

    // Mine to one block short of maturity: confirmations = 999. Both the
    // wallet filter and qbitd must still treat the coinbase as immature.
    const coinbaseHeight = coinbaseBlock.height
    height = await rpc<number>('getblockcount')
    const blocksToAlmostMature = coinbaseHeight + QBIT_COINBASE_MATURITY - 2 - height
    expect(blocksToAlmostMature).toBeGreaterThan(0)
    await mineBlocks(blocksToAlmostMature, fundingAddress)
    height = await rpc<number>('getblockcount')
    expect(height - coinbaseHeight + 1).toBe(QBIT_COINBASE_MATURITY - 1)
    await waitForElectrsHeight(electrs, height)

    const almostMatureUtxos = await wallet.getQbitUtxos()
    expect(almostMatureUtxos.some(utxo => utxo.txid === coinbaseTx.txid)).toBe(false)
    const [stillRejected] = await rpc<any[]>('testmempoolaccept', [[rawHex]])
    expect(stillRejected.allowed).toBe(false)

    // One more block reaches exactly maturity; both sides must flip together.
    await mineBlocks(1, fundingAddress)
    height = await rpc<number>('getblockcount')
    expect(height - coinbaseHeight + 1).toBe(QBIT_COINBASE_MATURITY)
    await waitForElectrsHeight(electrs, height)

    await waitFor('wallet includes mature coinbase utxo', async () => {
      const utxos = await wallet.getQbitUtxos()
      return utxos.some(utxo => utxo.txid === coinbaseTx.txid) ? true : undefined
    })

    // The very same signed bytes are valid at the boundary.
    const [accepted] = await rpc<any[]>('testmempoolaccept', [[rawHex]])
    expect(accepted.allowed, `reject-reason: ${accepted['reject-reason']}`).toBe(true)

    const txid = await wallet.pushTx(rawHex)
    expect(txid).toBe(accepted.txid)
    await mineBlocks(1, fundingAddress)
    const { fee, tx } = await minedFee(txid)
    expect(tx.confirmations).toBeGreaterThanOrEqual(1)
    expect(fee).toBe(immatureSpend.estimatedFee)
  }, 600_000)

  it('rebroadcasts the retained signed transaction after a broadcast outage without re-signing', async () => {
    const fundTxid = await fundWalletAddress('0.004')
    const fundUtxo = (await wallet.getQbitUtxos()).find(utxo => utxo.txid === fundTxid)
    expect(fundUtxo).toBeDefined()

    const countBefore = await counterCount()
    const toSignData = await wallet.createSendQbitPsbt({
      to: recipient,
      amount: 100_000,
      feeRate: 2,
      qbitUtxoChain: ChainType.QBIT_REGTEST,
      qbitUtxos: [fundUtxo!],
    })
    // Sign exactly once: everything below must reuse these bytes.
    const signed = await wallet.signPsbtV2(toSignData)
    const countAfterSigning = await counterCount()
    expect(countAfterSigning).toBe(countBefore + toSignData.toSignInputs.length)
    const rawHex = rawTxFromSignedPsbtHex(signed.psbtHex!)
    const [acceptance] = await rpc<any[]>('testmempoolaccept', [[rawHex]])
    expect(acceptance.allowed, `reject-reason: ${acceptance['reject-reason']}`).toBe(true)
    const expectedTxid = acceptance.txid as string

    const signSpy = vi.spyOn(wallet, 'signPsbtV2')
    const originalBroadcast = EsploraClient.prototype.broadcastTx
    const broadcastSpy = vi.spyOn(EsploraClient.prototype, 'broadcastTx')
    try {
      // Outage: the broadcast transport is down and nothing reaches qbitd.
      // The wallet cannot prove that, so the verdict must stay unknown.
      broadcastSpy.mockRejectedValue(
        new QbitApiError('network', `network error: ${ELECTRS_URL}/tx (TypeError: fetch failed)`)
      )
      const outage = await wallet.broadcastQbitTx(signed.psbtHex!)
      expect(outage).toMatchObject({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: expectedTxid,
        outcome: 'unknown',
        reason: 'network',
        lookup: 'gone',
      })
      expect(JSON.stringify(outage)).not.toContain(rawHex)
      expect(JSON.stringify(outage)).not.toContain('127.0.0.1')
      await expect(rpc('getmempoolentry', [expectedTxid])).rejects.toThrow(/not in mempool/i)
      expect(await counterCount()).toBe(countAfterSigning)

      // A status check while the transaction is genuinely absent must neither
      // upgrade to success nor claim the payment was not sent.
      await expect(
        wallet.checkQbitBroadcastStatus(expectedTxid, ChainType.QBIT_REGTEST)
      ).resolves.toEqual({ found: false, txid: expectedTxid, state: 'gone' })

      // Restore the transport and rebroadcast the retained bytes.
      broadcastSpy.mockRestore()
      const retry = await wallet.broadcastQbitTx(signed.psbtHex!, undefined, ChainType.QBIT_REGTEST)
      expect(retry).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: expectedTxid,
        via: 'broadcast',
      })
      await rpc('getmempoolentry', [expectedTxid])
      expect(await counterCount()).toBe(countAfterSigning)
      expect(signSpy).not.toHaveBeenCalled()

      const found = await waitFor('rebroadcast transaction indexed as pending', async () => {
        const status = await wallet.checkQbitBroadcastStatus(expectedTxid, ChainType.QBIT_REGTEST)
        return status.found ? status : undefined
      })
      expect(found).toEqual({ found: true, txid: expectedTxid, state: 'pending' })

      // Lost response: qbitd receives the same bytes again but the reply never
      // arrives. The node already holds the transaction, so the verdict must
      // resolve to success on the same txid, never to "not sent".
      vi.spyOn(EsploraClient.prototype, 'broadcastTx').mockImplementation(async function (
        this: EsploraClient,
        hex: string
      ) {
        await originalBroadcast.call(this, hex).catch(() => undefined)
        throw new QbitApiError('timeout', `request timed out after 15000ms: ${ELECTRS_URL}/tx`)
      })
      const lostResponse = await wallet.broadcastQbitTx(
        signed.psbtHex!,
        undefined,
        ChainType.QBIT_REGTEST
      )
      expect(lostResponse).toEqual({
        success: true,
        chain: ChainType.QBIT_REGTEST,
        txid: expectedTxid,
        via: 'lookup',
      })
      expect(await counterCount()).toBe(countAfterSigning)
      expect(signSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }

    await mineBlocks(1, fundingAddress)
    const { fee, tx } = await minedFee(expectedTxid)
    expect(tx.confirmations).toBeGreaterThanOrEqual(1)
    expect(fee).toBe(toSignData.estimatedFee)
    expect(await counterCount()).toBe(countAfterSigning)
  }, 600_000)
})
