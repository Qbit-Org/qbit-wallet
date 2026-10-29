import { verify as verifyPqc } from '@qbit-oss/pqc'
import {
  bytesToHex as qbitBytesToHex,
  decodeP2mrWitnessSignature,
  decodePsbt as decodeQbitPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes as qbitHexToBytes,
  parsePsbt as parseQbitPsbt,
  p2mrSighash,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  psbtUnsignedTransaction,
  serializePsbt as serializeQbitPsbt,
  verifyP2mrMessageProof,
  type P2mrTransaction,
  type Psbt as QbitPsbt,
} from '@qbit-oss/protocol'
import {
  RequestMethodSendQbitParams,
  RequestMethodSignMessageParams,
  RequestMethodSignPsbtParams,
  RequestMethodSignPsbtsParams,
  RequestMethodVerifyMessageParams,
} from '@qbit/wallet-shared'
import { permissionService, sessionService } from '../../services'
// Module-path import keeps the capability independently mockable in tests.
import regtestAccessService from '../../services/regtestAccess'
import { qbitP2mrSigningLeafRecord } from '../../utils/qbit-p2mr-signing-leaf'
import { amountToSatoshis } from '../../utils/qbit-utils'
import BaseController from '../base'
import wallet from '../wallet'

import {
  CHAINS_MAP,
  ErrorCodes,
  QbitExternalSigningLock,
  SESSION_EVENTS,
  SignMessageResult,
  SignMessageType,
  SignPsbtResult,
  QbitBroadcastResult,
  QbitSendBroadcastClaim,
  ToSignData,
  ToSignMessage,
  WalletError,
  assertQbitFeeRateWithinPolicy,
  chainForNetwork,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

function qbitUnsignedTxKey(tx: P2mrTransaction) {
  return {
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map(input => ({
      txid: qbitBytesToHex(input.prevout.txid),
      vout: input.prevout.vout,
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map(output => ({
      value: output.value.toString(),
      scriptPubKey: qbitBytesToHex(output.scriptPubKey),
    })),
  }
}

function assertSameQbitUnsignedTx(psbt: QbitPsbt, sourcePsbt: QbitPsbt) {
  if (
    JSON.stringify(qbitUnsignedTxKey(psbtUnsignedTransaction(psbt))) !==
    JSON.stringify(qbitUnsignedTxKey(psbtUnsignedTransaction(sourcePsbt)))
  ) {
    throw new Error('invalid psbt')
  }
}

function qbitBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return qbitBytesToHex(left) === qbitBytesToHex(right)
}

function readCompactSize(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  const first = bytes[offset]
  if (first === undefined) throw new Error('invalid final P2MR witness')
  if (first < 0xfd) return { value: first, offset: offset + 1 }

  const byteLength = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
  if (offset + 1 + byteLength > bytes.length) throw new Error('invalid final P2MR witness')
  let value = 0n
  for (let index = 0; index < byteLength; index += 1) {
    value |= BigInt(bytes[offset + 1 + index]!) << BigInt(index * 8)
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid final P2MR witness')
  return { value: Number(value), offset: offset + 1 + byteLength }
}

function parseFinalP2mrWitness(bytes: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const count = readCompactSize(bytes, 0)
  if (count.value !== 3) throw new Error('invalid final P2MR witness')
  let offset = count.offset
  const stack: Uint8Array[] = []
  for (let index = 0; index < count.value; index += 1) {
    const length = readCompactSize(bytes, offset)
    offset = length.offset
    if (offset + length.value > bytes.length) throw new Error('invalid final P2MR witness')
    stack.push(bytes.slice(offset, offset + length.value))
    offset += length.value
  }
  if (offset !== bytes.length) throw new Error('invalid final P2MR witness')
  return stack as [Uint8Array, Uint8Array, Uint8Array]
}

function qbitFinalWitness(input: QbitPsbt['inputs'][number] | undefined): Uint8Array | undefined {
  return input?.find(
    entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
  )?.value
}

function assertRequiredQbitP2mrSignatures(
  psbt: QbitPsbt,
  sourcePsbt: QbitPsbt,
  toSignData: ToSignData
) {
  const summary = decodeQbitPsbt(psbt)
  const sourceSummary = decodeQbitPsbt(sourcePsbt)
  const tx = psbtUnsignedTransaction(sourcePsbt)
  const spentOutputs = sourceSummary.inputs.map((input, inputIndex) => {
    if (!input.witnessUtxo) {
      throw new Error(`approved PSBT input ${inputIndex} is missing a witness UTXO`)
    }
    return input.witnessUtxo
  })

  for (const toSignInput of toSignData.qbitP2mrSigningKeys!) {
    const input = summary.inputs[toSignInput.inputIndex]
    const sourceInput = sourceSummary.inputs[toSignInput.inputIndex]
    if (!input || !sourceInput || !input.witnessUtxo || !sourceInput.witnessUtxo) {
      throw new Error('invalid psbt')
    }
    if (
      input.witnessUtxo.value !== sourceInput.witnessUtxo.value ||
      !qbitBytesEqual(input.witnessUtxo.scriptPubKey, sourceInput.witnessUtxo.scriptPubKey)
    ) {
      throw new Error('signed PSBT changed an approved witness UTXO')
    }

    // The record finalize reveals, as the plan was prepared against it.
    const expectedLeaf = qbitP2mrSigningLeafRecord(
      sourceInput,
      toSignInput.inputIndex,
      toSignInput.leafHash
    )

    let witnessSignature: ReturnType<typeof decodeP2mrWitnessSignature>
    if (input.finalized) {
      const finalWitness = qbitFinalWitness(psbt.inputs[toSignInput.inputIndex])
      if (!finalWitness) throw new Error('invalid psbt')
      const [signature, leafScript, controlBlock] = parseFinalP2mrWitness(finalWitness)
      if (
        !qbitBytesEqual(leafScript, expectedLeaf.script) ||
        !qbitBytesEqual(controlBlock, expectedLeaf.controlBlock)
      ) {
        throw new Error('signed PSBT changed the approved P2MR leaf')
      }
      witnessSignature = decodeP2mrWitnessSignature(signature)
    } else {
      const signatures = input.scriptSigs.filter(
        sig =>
          qbitBytesToHex(sig.pubkey) === toSignInput.publicKey &&
          qbitBytesToHex(sig.leafHash) === toSignInput.leafHash
      )
      if (signatures.length !== 1) throw new Error('invalid psbt')
      witnessSignature = signatures[0]!.signature
    }

    const expectedHashType = toSignInput.hashType ?? 0
    if (witnessSignature.hashType !== expectedHashType) {
      throw new Error('signed PSBT changed the approved sighash type')
    }
    const sighash = p2mrSighash({
      tx,
      inputIndex: toSignInput.inputIndex,
      spentOutputs,
      leafHash: qbitHexToBytes(toSignInput.leafHash),
      hashType: witnessSignature.hashType,
    })
    if (
      verifyPqc(qbitHexToBytes(toSignInput.publicKey), sighash, witnessSignature.signature) !== true
    ) {
      throw new Error('invalid P2MR signature')
    }
  }
}

/**
 * An input another signer finalized in the request must come back with the
 * same final witness and witness UTXO: no signing plan covers it, so
 * assertRequiredQbitP2mrSignatures never looks at it.
 */
function assertSourceFinalizedQbitInputsKept(psbt: QbitPsbt, sourcePsbt: QbitPsbt): void {
  const summary = decodeQbitPsbt(psbt)
  const sourceSummary = decodeQbitPsbt(sourcePsbt)
  sourcePsbt.inputs.forEach((sourceInput, inputIndex) => {
    const sourceWitness = qbitFinalWitness(sourceInput)
    if (!sourceWitness) return
    const witness = qbitFinalWitness(psbt.inputs[inputIndex])
    const utxo = summary.inputs[inputIndex]?.witnessUtxo
    const sourceUtxo = sourceSummary.inputs[inputIndex]?.witnessUtxo
    if (
      !witness ||
      !qbitBytesEqual(witness, sourceWitness) ||
      utxo?.value !== sourceUtxo?.value ||
      !qbitBytesEqual(
        utxo?.scriptPubKey ?? new Uint8Array(),
        sourceUtxo?.scriptPubKey ?? new Uint8Array()
      )
    ) {
      throw new Error('signed PSBT changed an input finalized before approval')
    }
  })
}

function approvedSignedQbitPsbt(toSignData: ToSignData, psbtHex?: string): string {
  if (!psbtHex) throw new Error('invalid psbt')
  if (!toSignData.qbitP2mrSigningKeys?.length) {
    throw new Error('invalid Qbit signing plan')
  }

  const psbt = parseQbitPsbt(qbitHexToBytes(formatQbitPsbtHex(psbtHex)))
  const sourcePsbt = parseQbitPsbt(qbitHexToBytes(toSignData.psbtHex))
  assertSameQbitUnsignedTx(psbt, sourcePsbt)
  assertRequiredQbitP2mrSignatures(psbt, sourcePsbt, toSignData)
  assertSourceFinalizedQbitInputsKept(psbt, sourcePsbt)

  if (toSignData.autoFinalized !== false) {
    const finalized = finalizeP2mrPsbt(psbt)
    extractP2mrTransaction(finalized)
    return qbitBytesToHex(serializeQbitPsbt(finalized))
  }
  // An input another signer had already finalized in the request comes back
  // as it was (checked above); only one the approval finalized breaks
  // partial signing.
  const sourceInputs = decodeQbitPsbt(sourcePsbt).inputs
  if (
    decodeQbitPsbt(psbt).inputs.some(
      (input, index) => input.finalized && !sourceInputs[index]?.finalized
    )
  ) {
    throw new Error('approval returned a finalized PSBT when partial signing was requested')
  }
  return qbitBytesToHex(serializeQbitPsbt(psbt))
}

function getToSignDatas(toSignDatas: ToSignData[] | undefined, expectedLength = 1) {
  if (!toSignDatas || toSignDatas.length !== expectedLength) {
    throw new Error('invalid psbt')
  }
  return toSignDatas
}

function sameQbitSendBroadcastClaim(
  left: QbitSendBroadcastClaim | undefined,
  right: QbitSendBroadcastClaim | undefined
): right is QbitSendBroadcastClaim {
  return Boolean(
    left &&
      right &&
      left.chain === right.chain &&
      left.address === right.address &&
      left.origin === right.origin &&
      left.txid === right.txid &&
      left.outpoints.length === right.outpoints.length &&
      left.outpoints.every(
        (outpoint, index) =>
          outpoint.txid === right.outpoints[index]?.txid &&
          outpoint.vout === right.outpoints[index]?.vout
      )
  )
}

/**
 * Turn the wallet send path's verdict on a broadcast of `transaction` into
 * what the dapp receives. An accepted transaction, or one a follow-up lookup
 * finds, returns its txid. Proven non-submission throws a plain error.
 * Anything inconclusive throws QBIT_BROADCAST_OUTCOME_UNKNOWN naming the
 * transaction: the node may hold it, and the dapp has to check that txid
 * rather than retry into a second payment.
 */
function answerQbitProviderBroadcast(
  result: QbitBroadcastResult,
  transaction: { chain?: ChainType | undefined; txid?: string | undefined }
): string {
  if (result.success) return result.txid
  if (result.outcome === 'not_sent') {
    throw new Error(result.detail ?? `Qbit transaction was not broadcast (${result.reason})`)
  }
  const data: { outcome: 'unknown'; chain?: ChainType; txid?: string } = { outcome: 'unknown' }
  if (transaction.chain !== undefined) data.chain = transaction.chain
  if (transaction.txid !== undefined) data.txid = transaction.txid
  const error = new WalletError(
    ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
    'Qbit transaction broadcast outcome is unknown; check the transaction before retrying'
  ) as WalletError & { data: typeof data }
  error.data = data
  throw error
}

/**
 * Broadcast an approved sendQbit under its claim with the wallet send path's
 * verdicts (`broadcastQbitTx`). Proven non-submission lets the request's
 * failure cleanup release the claim. Anything inconclusive, including a
 * guard refusal of a claim it no longer holds, names the claim's
 * transaction, so the cleanup retires the claim with its inputs still
 * reserved as recently spent.
 */
async function broadcastQbitProviderSend(
  psbtHex: string,
  claim: QbitSendBroadcastClaim
): Promise<string> {
  // broadcastQbitTx reports every failure as a verdict; anything it throws
  // is unexpected, and may come after the bytes left, so it counts as an
  // unknown outcome rather than proof that nothing was sent.
  const result = await wallet
    .broadcastQbitTx(psbtHex, claim, claim.chain, claim.txid)
    .catch(error => {
      console.error('Unexpected failure broadcasting a Qbit sendQbit transaction', error)
      return { success: false as const, outcome: 'unknown' as const, reason: 'unexpected' as const }
    })
  return answerQbitProviderBroadcast(result, claim)
}

/**
 * Broadcast bytes a dapp pushed (pushTx, pushPsbt) with the same verdicts
 * (`broadcastQbitProviderTx`). An unknown outcome names the transaction the
 * bytes encode; its inputs stay reserved only when the user approved
 * signing that transaction for a dapp.
 */
async function broadcastQbitProviderPush(txData: string): Promise<string> {
  const result = await wallet.broadcastQbitProviderTx(txData)
  return answerQbitProviderBroadcast(result, result)
}

function sameQbitExternalSigningLock(
  left: QbitExternalSigningLock | undefined,
  right: QbitExternalSigningLock | undefined
): left is QbitExternalSigningLock {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.purpose === right.purpose &&
      left.chain === right.chain &&
      left.address === right.address &&
      left.origin === right.origin &&
      left.entries.length === right.entries.length &&
      left.entries.every((entry, entryIndex) => {
        const other = right.entries[entryIndex]
        return Boolean(
          other &&
            entry.txid === other.txid &&
            entry.outpoints.length === other.outpoints.length &&
            entry.outpoints.every(
              (outpoint, outpointIndex) =>
                outpoint.txid === other.outpoints[outpointIndex]?.txid &&
                outpoint.vout === other.outpoints[outpointIndex]?.vout
            )
        )
      })
  )
}

function externalQbitSigningLock(
  toSignDatas: readonly ToSignData[],
  purpose: QbitExternalSigningLock['purpose']
): QbitExternalSigningLock | undefined {
  const lock = toSignDatas[0]?.qbitExternalSigningLock
  if (!lock) {
    if (toSignDatas.some(toSignData => toSignData.qbitExternalSigningLock)) {
      throw new Error('invalid external Qbit signing lock')
    }
    return
  }
  if (
    lock.purpose !== purpose ||
    toSignDatas.some(
      toSignData => !sameQbitExternalSigningLock(lock, toSignData.qbitExternalSigningLock)
    )
  ) {
    throw new Error('invalid external Qbit signing lock')
  }
  return lock
}

function getToSignMessages(toSignMessages?: ToSignMessage[]) {
  if (!toSignMessages?.length) {
    throw new Error('invalid message')
  }
  return toSignMessages
}

function approvedMessageProof(
  toSignMessage: ToSignMessage,
  approved: SignMessageResult[number] | undefined
) {
  if (toSignMessage.type !== SignMessageType.P2MR || !approved?.proof) {
    throw new Error('invalid P2MR message proof')
  }
  const expectedAddress = toSignMessage.p2mrAccountAddress
  if (
    typeof expectedAddress !== 'string' ||
    approved.proof.address !== expectedAddress ||
    !verifyP2mrMessageProof(toSignMessage.text, approved.proof, verifyPqc, { expectedAddress })
  ) {
    throw new Error('P2MR message proof does not match the approved request')
  }
  return approved.proof
}

function formatQbitPsbtHex(psbtData: string) {
  try {
    if (
      typeof psbtData !== 'string' ||
      psbtData.length === 0 ||
      psbtData.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(psbtData)
    ) {
      throw new Error('invalid psbt')
    }
    return qbitBytesToHex(serializeQbitPsbt(parseQbitPsbt(qbitHexToBytes(psbtData))))
  } catch (e) {
    throw new Error('invalid psbt')
  }
}

const QBIT_PROVIDER_CHAINS = new Set<ChainType>([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])

const QBIT_NETWORK_BY_CHAIN: Record<ChainType, 'mainnet' | 'testnet4' | 'regtest'> = {
  [ChainType.QBIT_MAINNET]: 'mainnet',
  [ChainType.QBIT_TESTNET4]: 'testnet4',
  [ChainType.QBIT_REGTEST]: 'regtest',
}

function assertSupportedQbitChain(chain: unknown): asserts chain is ChainType {
  if (!QBIT_PROVIDER_CHAINS.has(chain as ChainType)) {
    throw new Error(`unsupported Qbit chain; expected ${[...QBIT_PROVIDER_CHAINS].join(', ')}`)
  }
  const config = CHAINS_MAP[chain as ChainType]
  if (!config || config.disable || config.mainnetReady === false) {
    throw new Error('requested Qbit chain is unavailable')
  }
}

/**
 * Guard for chains a dapp asks to switch *into*. Local regtest additionally
 * requires the background capability (live browser permission, in-app
 * acknowledgement, verified service). A locked capability rejects the request
 * with a stable error before any approval UI opens; the browser permission
 * prompt is never triggered from a dapp request.
 */
async function assertQbitChainSelectable(chain: unknown): Promise<ChainType> {
  assertSupportedQbitChain(chain)
  if (chain === ChainType.QBIT_REGTEST) {
    await regtestAccessService.assertAvailable()
  }
  return chain
}

function getActiveQbitChain(): ChainType {
  const chain = wallet.getChainType()
  assertSupportedQbitChain(chain)
  return chain
}

function getActiveQbitNetwork() {
  return QBIT_NETWORK_BY_CHAIN[getActiveQbitChain()]
}

function assertSigningChain(origin: string, requestedChain: unknown): ChainType {
  assertSupportedQbitChain(requestedChain)
  const activeChain = getActiveQbitChain()
  if (requestedChain !== activeChain) {
    throw new Error('requested chain does not match the active Qbit chain')
  }
  if (!permissionService.hasPermission(origin, activeChain)) {
    throw new Error('origin is not connected to the active Qbit chain')
  }
  return activeChain
}

class ProviderController extends BaseController {
  protected override onInitialize(): Promise<void> {
    return Promise.resolve()
  }

  protected override onCleanup(): Promise<void> {
    return Promise.resolve()
  }

  requestAccounts = async ({ session: { origin } }) => {
    const chain = getActiveQbitChain()
    if (!permissionService.hasPermission(origin, chain)) {
      throw new Error('origin is not connected to the active Qbit chain')
    }

    const currentAccount = await wallet.getCurrentAccount()
    const accounts = currentAccount ? [currentAccount.address] : []
    sessionService.broadcastEvent(SESSION_EVENTS.chainChanged, chain, origin)
    sessionService.broadcastEvent(SESSION_EVENTS.networkChanged, getActiveQbitNetwork(), origin)
    sessionService.broadcastEvent(SESSION_EVENTS.accountsChanged, accounts, origin)
    return accounts
  }

  @Reflect.metadata('SAFE', true)
  disconnect = async ({ session: { origin } }) => {
    await wallet.removeConnectedSite(origin)
  }

  @Reflect.metadata('SAFE', true)
  getAccounts = async ({ session: { origin } }) => {
    const chain = getActiveQbitChain()
    if (!permissionService.hasPermission(origin, chain)) {
      return []
    }
    const currentAccount = await wallet.getCurrentAccount()
    return currentAccount ? [currentAccount.address] : []
  }

  @Reflect.metadata('SAFE', true)
  getNetwork = async () => getActiveQbitNetwork()

  // switchNetwork and switchChain are not SAFE: requested while the wallet is
  // locked, they ask for the unlock first, so the context their approval
  // checks is read from the unlocked wallet.
  @Reflect.metadata('APPROVAL', [
    'SwitchNetwork',
    async req => {
      const targetChain = await assertQbitChainSelectable(chainForNetwork(req.data.params.network))
      return targetChain === getActiveQbitChain()
    },
  ])
  switchNetwork = async ({ data: { params }, session: { origin } }) => {
    const targetChain = await assertQbitChainSelectable(chainForNetwork(params.network))
    await wallet.switchProviderChain(origin, targetChain)
  }

  @Reflect.metadata('SAFE', true)
  getChain = async () => getActiveQbitChain()

  @Reflect.metadata('APPROVAL', [
    'SwitchChain',
    async req => {
      const targetChain = await assertQbitChainSelectable(req.data.params.chain)
      return targetChain === getActiveQbitChain()
    },
  ])
  switchChain = async ({ data: { params }, session: { origin } }) => {
    await assertQbitChainSelectable(params.chain)
    await wallet.switchProviderChain(origin, params.chain)
  }

  @Reflect.metadata('SAFE', true)
  getPublicKey = async () => {
    const account = await wallet.getCurrentAccount()
    if (!account) return ''
    return account.pubkey
  }

  @Reflect.metadata('SAFE', true)
  getBalance = async () => {
    const account = await wallet.getCurrentAccount()
    if (!account) return null
    const balance = await wallet.getAddressBalance(account.address)
    return {
      confirmed: amountToSatoshis(balance.confirm_amount),
      unconfirmed: amountToSatoshis(balance.pending_amount),
      total: amountToSatoshis(balance.amount),
    }
  }

  @Reflect.metadata('APPROVAL', [
    'SignPsbt',
    async req => {
      const params: RequestMethodSendQbitParams = req.data.params
      const { toAddress, satoshis, feeRate, memo, memos } = params.sendQbitParams || {}
      if (typeof toAddress !== 'string' || !toAddress) {
        throw new Error('toAddress is required')
      }
      if (!Number.isSafeInteger(satoshis) || satoshis <= 0) {
        throw new Error('satoshis must be a positive safe integer')
      }
      if (feeRate !== undefined) assertQbitFeeRateWithinPolicy(feeRate)
      const toSignData = await wallet.createSendQbitPsbt({
        to: toAddress,
        amount: satoshis,
        ...(feeRate !== undefined ? { feeRate } : {}),
        ...(memo !== undefined ? { memo } : {}),
        ...(memos !== undefined ? { memos } : {}),
      })
      toSignData.providerContext = req.providerContext
      toSignData.qbitSendBroadcastClaim = wallet.createQbitSendBroadcastClaim(
        toSignData.psbtHex,
        req.providerContext
      )
      const externalSigningLock = await wallet.acquireExternalQbitSigningLock([toSignData], 'send')
      if (externalSigningLock) toSignData.qbitExternalSigningLock = externalSigningLock
      params.toSignDatas = [toSignData]
    },
  ])
  sendQbit = async ({
    data: { params },
    approvalRes,
  }: {
    data: { params: RequestMethodSendQbitParams }
    approvalRes: SignPsbtResult
  }) => {
    const toSignData = getToSignDatas(params.toSignDatas)[0]!
    const signedData = approvalRes?.length === 1 ? approvalRes[0] : undefined
    const externalSigningLock = externalQbitSigningLock([toSignData], 'send')
    const signedClaim = signedData?.qbitSendBroadcastClaim
    if (
      !externalSigningLock &&
      !sameQbitSendBroadcastClaim(toSignData.qbitSendBroadcastClaim, signedClaim)
    ) {
      throw new Error('invalid Qbit send broadcast claim')
    }
    const signedPsbt = signedData?.psbtHex
    const approvedPsbt = approvedSignedQbitPsbt(toSignData, signedPsbt)
    if (externalSigningLock) {
      const claim = toSignData.qbitSendBroadcastClaim
      if (!claim) throw new Error('invalid Qbit send broadcast claim')
      await wallet.promoteExternalQbitSendBroadcastClaim({
        psbtHex: toSignData.psbtHex,
        claim,
        lock: externalSigningLock,
        providerContext: toSignData.providerContext,
      })
      return await broadcastQbitProviderSend(approvedPsbt, claim)
    }

    if (!signedClaim) throw new Error('invalid Qbit send broadcast claim')
    return await broadcastQbitProviderSend(approvedPsbt, signedClaim)
  }

  @Reflect.metadata('APPROVAL', [
    'SignMessage',
    async req => {
      const params: RequestMethodSignMessageParams = req.data.params
      if (typeof params.text !== 'string' || params.text.trim().length === 0) {
        throw new Error('text is required')
      }
      if (params.text.length > 10000) {
        throw new Error('message is too long')
      }
      const { accountAddress, signatureBudget } = await wallet.preflightP2mrMessageSigning([
        params.text,
      ])
      params.toSignMessages = [
        {
          text: params.text,
          type: SignMessageType.P2MR,
          p2mrAccountAddress: accountAddress,
          providerContext: req.providerContext,
          signatureBudget,
        },
      ]
    },
  ])
  signMessage = async ({
    data: { params },
    approvalRes,
  }: {
    data: { params: RequestMethodSignMessageParams }
    approvalRes: SignMessageResult
  }) => {
    const toSignMessage = getToSignMessages(params.toSignMessages)[0]!
    return approvedMessageProof(
      toSignMessage,
      approvalRes?.length === 1 ? approvalRes[0] : undefined
    )
  }

  @Reflect.metadata('SAFE', true)
  verifyMessage = async ({
    data: { params },
  }: {
    data: { params: RequestMethodVerifyMessageParams }
  }) => {
    if (
      typeof params?.address !== 'string' ||
      typeof params?.text !== 'string' ||
      params.text.length > 10000 ||
      params.proof?.address !== params.address
    ) {
      return false
    }
    try {
      return verifyP2mrMessageProof(params.text, params.proof, verifyPqc, {
        expectedAddress: params.address,
      })
    } catch {
      return false
    }
  }

  @Reflect.metadata('SAFE', true)
  pushTx = async ({
    data: {
      params: { rawtx },
    },
  }) => {
    getActiveQbitChain()
    if (
      typeof rawtx !== 'string' ||
      rawtx.length === 0 ||
      rawtx.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(rawtx)
    ) {
      throw new Error('invalid raw Qbit transaction')
    }
    return await broadcastQbitProviderPush(rawtx.toLowerCase())
  }

  @Reflect.metadata('APPROVAL', [
    'SignPsbt',
    async req => {
      const params: RequestMethodSignPsbtParams = req.data.params
      assertSigningChain(req.session.origin, params.options?.chain)
      const psbtHex = formatQbitPsbtHex(params.psbtHex)
      const toSignData = await wallet.prepareQbitProviderPsbt(psbtHex, params.options)
      toSignData.providerContext = req.providerContext
      const externalSigningLock = await wallet.acquireExternalQbitSigningLock([toSignData], 'sign')
      if (externalSigningLock) toSignData.qbitExternalSigningLock = externalSigningLock
      params.toSignDatas = [toSignData]
    },
  ])
  signPsbt = async ({
    data: { params },
    approvalRes,
  }: {
    data: { params: RequestMethodSignPsbtParams }
    approvalRes: SignPsbtResult
  }) => {
    const toSignData = getToSignDatas(params.toSignDatas)[0]!
    const signedPsbt = approvalRes?.length === 1 ? approvalRes[0]?.psbtHex : undefined
    const approvedPsbt = approvedSignedQbitPsbt(toSignData, signedPsbt)
    const externalSigningLock = externalQbitSigningLock([toSignData], 'sign')
    if (externalSigningLock) {
      await wallet.completeExternalQbitSigningLock(externalSigningLock)
    }
    // Queued before the dapp gets the bytes, so its broadcast of them is
    // decided after it, without the answer waiting on the send guard.
    void wallet.recordQbitProviderSignings([toSignData.qbitBroadcastIdentity])
    return approvedPsbt
  }

  @Reflect.metadata('APPROVAL', [
    'SignPsbt',
    async req => {
      const params: RequestMethodSignPsbtsParams = req.data.params
      if (
        !Array.isArray(params.psbtHexs) ||
        params.psbtHexs.length === 0 ||
        params.psbtHexs.length > 20 ||
        !Array.isArray(params.options) ||
        params.options.length !== params.psbtHexs.length
      ) {
        throw new Error('signPsbts requires one option for each of 1-20 PSBTs')
      }

      params.toSignDatas = []
      const preparedPsbtHexs: string[] = []
      const preparedPsbtHexCounts = new Map<string, number>()
      for (let i = 0; i < params.psbtHexs.length; i++) {
        const options = params.options[i]!
        assertSigningChain(req.session.origin, options?.chain)
        const psbtHex = formatQbitPsbtHex(params.psbtHexs[i]!)
        const toSignData = await wallet.prepareQbitProviderPsbt(psbtHex, options)
        toSignData.providerContext = req.providerContext
        preparedPsbtHexs.push(psbtHex)
        preparedPsbtHexCounts.set(psbtHex, (preparedPsbtHexCounts.get(psbtHex) ?? 0) + 1)
        params.toSignDatas.push(toSignData)
      }
      // Batch entries may be signed in any order, so every entry of a
      // duplicated PSBT — including the first prepared — may find its
      // approved signatures already cached by another entry of the batch.
      params.toSignDatas.forEach((toSignData, index) => {
        if (preparedPsbtHexCounts.get(preparedPsbtHexs[index]!)! > 1) {
          toSignData.qbitApprovedBatchDuplicate = true
        }
      })
      const externalSigningLock = await wallet.acquireExternalQbitSigningLock(
        params.toSignDatas,
        'sign'
      )
      if (externalSigningLock) {
        params.toSignDatas.forEach(toSignData => {
          toSignData.qbitExternalSigningLock = externalSigningLock
        })
      }
    },
  ])
  signPsbts = async ({
    data: { params },
    approvalRes,
  }: {
    data: { params: RequestMethodSignPsbtsParams }
    approvalRes: SignPsbtResult
  }) => {
    const toSignDatas = getToSignDatas(params.toSignDatas, params.psbtHexs.length)
    if (!Array.isArray(approvalRes) || approvalRes.length !== toSignDatas.length) {
      throw new Error('invalid batch signing result')
    }
    const approvedPsbts = toSignDatas.map((toSignData, index) => {
      const signedPsbt = approvalRes[index]?.psbtHex
      return approvedSignedQbitPsbt(toSignData, signedPsbt)
    })
    const externalSigningLock = externalQbitSigningLock(toSignDatas, 'sign')
    if (externalSigningLock) {
      await wallet.completeExternalQbitSigningLock(externalSigningLock)
    }
    void wallet.recordQbitProviderSignings(
      toSignDatas.map(toSignData => toSignData.qbitBroadcastIdentity)
    )
    return approvedPsbts
  }

  @Reflect.metadata('SAFE', true)
  pushPsbt = async ({
    data: {
      params: { psbtHex },
    },
  }) => {
    getActiveQbitChain()
    return await broadcastQbitProviderPush(formatQbitPsbtHex(psbtHex))
  }
}

export default new ProviderController()
