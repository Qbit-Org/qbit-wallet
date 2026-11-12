import {
  P2MR_LEAF_VERSION_V1,
  addressToScriptPubKey,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  singleKeyLeafScript,
  type P2mrSigningKey,
  type P2mrTransactionOutput,
  type Psbt,
  type PsbtSummary,
} from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  estimateQbitP2mrTransaction,
  type QbitSendPlan,
  type QbitSelectableCoin,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { qbitSendPlanFeeProblem, type QbitSendPlanFeeProblem } from './qbit-send-plan-revision'

/**
 * Sequence of every merge's inputs: replaceable, so a merge that stays
 * unconfirmed can be replaced by one paying a higher fee.
 */
export const QBIT_SEND_PLAN_RBF_SEQUENCE = 0xfffffffd
/** Sequence of a payment built without replaceability. */
export const QBIT_SEND_PLAN_FINAL_SEQUENCE = 0xffffffff

/** The account's single-key P2MR spend, from its public key. */
export interface QbitSendPlanAccountKeys {
  /** Lower-case hex of the 32-byte public key. */
  pubkey: string
  leafScript: Uint8Array
  leafHash: Uint8Array
  controlBlock: Uint8Array
  /** The script every output of the account pays. */
  scriptPubKey: Uint8Array
}

/** An outpoint a step spends, with what it holds. */
export interface QbitSendPlanStepInput {
  txid: string
  vout: number
  satoshis: number
}

/** One transaction of a plan, built and checked against the planner's figures. */
export interface QbitSendPlanBuiltStep {
  kind: 'merge' | 'payment'
  txid: string
  psbtHex: string
  inputs: QbitSendPlanStepInput[]
  vsize: number
  fee: number
  /** The rate it was priced at, in bits/vB. */
  feeRate: number
  /** merge: what its single output pays back to the account. */
  outputValue?: number
}

/**
 * Thrown when a transaction the plan built is not the one the planner priced,
 * or a stored one is not the transaction the plan recorded. Either is an
 * internal error: the plan is never quietly changed to fit. `what` names the
 * step and the figure that differs, never a stored value.
 */
export class QbitSendPlanTransactionMismatchError extends Error {
  constructor(readonly what: string) {
    super(`Qbit send plan transaction does not match its plan: ${what}`)
    this.name = 'QbitSendPlanTransactionMismatchError'
  }
}

/** The name the protocol gives the network of `chain`, a Qbit network. */
function networkNameOf(chain: ChainType): 'mainnet' | 'testnet4' | 'regtest' {
  if (chain === ChainType.QBIT_MAINNET) return 'mainnet'
  if (chain === ChainType.QBIT_TESTNET4) return 'testnet4'
  if (chain === ChainType.QBIT_REGTEST) return 'regtest'
  throw new QbitSendPlanTransactionMismatchError('the network is not a Qbit network')
}

/**
 * The script paying `address`, a P2MR address of `chain`'s network, as the
 * ordinary send decodes one; throws `QbitSendPlanTransactionMismatchError`
 * for anything else.
 */
export function qbitSendPlanAddressScript(chain: ChainType, address: string): Uint8Array {
  const network = networkNameOf(chain)
  try {
    return addressToScriptPubKey(address, network)
  } catch {
    throw new QbitSendPlanTransactionMismatchError(
      'an address is not a P2MR address of its network'
    )
  }
}

/** The bytes of the unsigned transaction `psbt` holds; throws when it holds none. */
function unsignedTransactionBytes(psbt: Psbt): Uint8Array {
  const entry = psbt.global.find(item => item.key.length === 1 && item.key[0] === 0)
  if (!entry) throw new QbitSendPlanTransactionMismatchError('a PSBT holds no transaction')
  return entry.value
}

/**
 * The id of the transaction `psbt` holds, as the wallet names one
 * (`qbitBroadcastIdentityOf`): the double SHA-256 of its unsigned
 * transaction, in explorer order. It depends only on the transaction's
 * inputs and outputs, so it is the same before and after signing.
 */
export function qbitSendPlanTxid(psbt: Psbt): string {
  const hash = transactionCore.crypto.hash256(Buffer.from(unsignedTransactionBytes(psbt)))
  return bytesToHex(new Uint8Array(hash).reverse())
}

/** The single-key spend of the account whose public key is `pubkey` (64 hex characters). */
export function qbitSendPlanAccountKeys(pubkey: string): QbitSendPlanAccountKeys {
  const normalized = pubkey.toLowerCase()
  const leafScript = singleKeyLeafScript(hexToBytes(normalized))
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  return {
    pubkey: normalized,
    leafScript,
    leafHash,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
    scriptPubKey: p2mrScriptPubKey(leafHash),
  }
}

/** A PSBT as the plan stores it: lower-case hex of its serialization. */
export function qbitSendPlanPsbtHex(psbt: Psbt): string {
  return bytesToHex(serializePsbt(psbt))
}

export function qbitSendPlanPsbtFromHex(psbtHex: string): Psbt {
  return parsePsbt(hexToBytes(psbtHex))
}

/** Explorer-order txid of an outpoint's internal-order bytes. */
function displayTxid(internal: Uint8Array): string {
  return bytesToHex(new Uint8Array(internal).reverse())
}

/** Internal-order bytes of an explorer-order txid. */
function internalTxid(txid: string): Uint8Array {
  const bytes = hexToBytes(txid)
  if (bytes.length !== 32) throw new QbitSendPlanTransactionMismatchError('a txid is not 32 bytes')
  return new Uint8Array(bytes).reverse()
}

/** `items[index]`, which the caller knows is there; a broken invariant throws. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new QbitSendPlanTransactionMismatchError('an item is missing')
  return item
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** The signing keys for every input of `psbt`, each spending the account's leaf. */
export function qbitSendPlanSigningKeys(
  psbt: Psbt,
  keys: QbitSendPlanAccountKeys
): P2mrSigningKey[] {
  const pubkey = hexToBytes(keys.pubkey)
  return decodePsbt(psbt).inputs.map((_, inputIndex) => ({
    inputIndex,
    pubkey,
    leafHash: keys.leafHash,
  }))
}

function stepPsbt(
  inputs: readonly QbitSendPlanStepInput[],
  outputs: readonly P2mrTransactionOutput[],
  sequence: number,
  keys: QbitSendPlanAccountKeys
): Psbt {
  return createP2mrPsbt({
    inputs: inputs.map(input => ({
      prevout: { txid: internalTxid(input.txid), vout: input.vout },
      sequence,
      witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
      leafScript: keys.leafScript,
      controlBlock: keys.controlBlock,
      merkleRoot: keys.leafHash,
    })),
    outputs,
  })
}

/** The exact serialized size of the transaction `summary` decodes, once signed with the account's leaf. */
function finalizedVsize(
  summary: PsbtSummary,
  keys: QbitSendPlanAccountKeys,
  feeRate: number
): number {
  return estimateQbitP2mrTransaction({
    inputCount: summary.inputs.length,
    outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
    leafScriptLength: keys.leafScript.length,
    controlBlockLength: keys.controlBlock.length,
    feeRate,
  }).vsize
}

/**
 * Which figure of the transaction `summary` decodes the wallet's own pricing
 * would not give it at `feeRate` (`qbitSendPlanFeeProblem`), read from the
 * transaction alone: its inputs, its outputs' scripts, its fee (what its
 * inputs' spent outputs hold less its outputs) and a merge's output value.
 * `foldsRemainder`: a payment of an amount without change.
 */
function pricingProblem(
  summary: PsbtSummary,
  kind: 'merge' | 'payment',
  feeRate: unknown,
  foldsRemainder: boolean,
  keys: QbitSendPlanAccountKeys
): QbitSendPlanFeeProblem | undefined {
  const output = summary.outputs[0]
  return qbitSendPlanFeeProblem(
    {
      kind,
      inputCount: summary.inputs.length,
      outputScriptLengths: summary.outputs.map(item => item.scriptPubKey.length),
      feeRate,
      fee: summary.fee === undefined ? Number.NaN : Number(summary.fee),
      ...(kind === 'merge'
        ? { outputValue: output === undefined ? Number.NaN : Number(output.value) }
        : { foldsRemainder }),
    },
    {
      accountScriptLength: keys.scriptPubKey.length,
      leafScriptLength: keys.leafScript.length,
      controlBlockLength: keys.controlBlock.length,
    }
  )
}

function inputTotal(inputs: readonly QbitSendPlanStepInput[]): number {
  return inputs.reduce((total, input) => total + input.satoshis, 0)
}

function outputTotal(outputs: readonly P2mrTransactionOutput[]): bigint {
  return outputs.reduce((total, output) => total + output.value, 0n)
}

/**
 * Build every transaction of `plan` as an unsigned PSBT, merges in order and
 * then the payment, and check each against what the planner priced: its fee
 * (inputs minus outputs) and exact size, the payment's spends of the merges'
 * outputs by the merges' own ids, and the recipient's output of exactly the
 * amount; and that each is priced as `checkQbitSendPlanStepPsbt` requires
 * before it is signed, at `feeRate`, the rate every step built here records.
 * Each merge spends its inputs to one output paying the account and
 * signals replaceability; the payment spends output 0 of every merge, then
 * the outputs it spends directly, and pays the recipient, the memo outputs
 * and, when the plan returns change, the change to the account. `txidOf`
 * names a transaction by its id, which depends only on its inputs and
 * outputs. Throws `QbitSendPlanTransactionMismatchError` on any mismatch.
 */
export function buildQbitSendPlanSteps<T extends QbitSelectableCoin>(params: {
  plan: QbitSendPlan<T>
  keys: QbitSendPlanAccountKeys
  recipientScript: Uint8Array
  memoOutputs: readonly P2mrTransactionOutput[]
  paymentSequence: number
  feeRate: number
  txidOf: (psbt: Psbt) => string
}): QbitSendPlanBuiltStep[] {
  const { plan, keys, recipientScript, memoOutputs, paymentSequence, feeRate, txidOf } = params
  const coinInput = (coin: T): QbitSendPlanStepInput => ({
    txid: coin.txid.toLowerCase(),
    vout: coin.vout,
    satoshis: coin.satoshis,
  })
  const check = (condition: boolean, what: string): void => {
    if (!condition) throw new QbitSendPlanTransactionMismatchError(what)
  }

  const merges = plan.merges.map((merge, index): QbitSendPlanBuiltStep => {
    const inputs = merge.inputs.map(coinInput)
    const outputs = [{ value: BigInt(merge.outputValue), scriptPubKey: keys.scriptPubKey }]
    const psbt = stepPsbt(inputs, outputs, QBIT_SEND_PLAN_RBF_SEQUENCE, keys)
    const summary = decodePsbt(psbt)
    check(
      BigInt(inputTotal(inputs)) - outputTotal(outputs) === BigInt(merge.fee),
      `merge ${index} fee`
    )
    check(finalizedVsize(summary, keys, feeRate) === merge.vsize, `merge ${index} size`)
    check(
      pricingProblem(summary, 'merge', feeRate, false, keys) === undefined,
      `merge ${index} pricing`
    )
    return {
      kind: 'merge',
      txid: txidOf(psbt),
      psbtHex: qbitSendPlanPsbtHex(psbt),
      inputs,
      vsize: merge.vsize,
      fee: merge.fee,
      feeRate,
      outputValue: merge.outputValue,
    }
  })

  const payment = plan.payment
  const paymentInputs = [
    ...merges.map(merge => ({ txid: merge.txid, vout: 0, satoshis: merge.outputValue ?? 0 })),
    ...payment.coins.map(coinInput),
  ]
  const paymentOutputs: P2mrTransactionOutput[] = [
    { value: BigInt(payment.amount), scriptPubKey: recipientScript },
    ...memoOutputs,
  ]
  if (payment.includeChange) {
    paymentOutputs.push({ value: BigInt(payment.change), scriptPubKey: keys.scriptPubKey })
  }
  const paymentPsbt = stepPsbt(paymentInputs, paymentOutputs, paymentSequence, keys)
  const summary = decodePsbt(paymentPsbt)
  check(paymentInputs.length === payment.inputCount, 'payment input count')
  check(
    BigInt(inputTotal(paymentInputs)) - outputTotal(paymentOutputs) === BigInt(payment.fee),
    'payment fee'
  )
  check(finalizedVsize(summary, keys, feeRate) === payment.vsize, 'payment size')
  check(
    pricingProblem(
      summary,
      'payment',
      feeRate,
      plan.target === 'amount' && !payment.includeChange,
      keys
    ) === undefined,
    'payment pricing'
  )
  merges.forEach((merge, index) => {
    const prevout = summary.inputs[index]?.prevout
    check(
      prevout !== undefined && prevout.vout === 0 && displayTxid(prevout.txid) === merge.txid,
      `payment input ${index} is not merge ${index}'s output`
    )
  })
  const recipient = summary.outputs[0]
  check(
    recipient !== undefined &&
      recipient.value === BigInt(payment.amount) &&
      sameBytes(recipient.scriptPubKey, recipientScript),
    'recipient output'
  )
  return [
    ...merges,
    {
      kind: 'payment',
      txid: txidOf(paymentPsbt),
      psbtHex: qbitSendPlanPsbtHex(paymentPsbt),
      inputs: paymentInputs,
      vsize: payment.vsize,
      fee: payment.fee,
      feeRate,
    },
  ]
}

/** What a stored step's PSBT must be, from the plan's record. */
export interface QbitSendPlanStepExpectation {
  kind: 'merge' | 'payment'
  txid: string
  inputs: readonly QbitSendPlanStepInput[]
  fee: number
  /** The rate the step was priced at, in bits/vB. */
  feeRate: number
  /** merge: its single output's value. */
  outputValue?: number
  /** payment: the recipient's script and the amount it receives. */
  recipientScript?: Uint8Array
  amount?: number
  /** payment: change returned to the account, 0 for none. */
  change?: number
  /** payment: whether it pays an amount, or everything the plan's outputs deliver. */
  target?: 'amount' | 'everything'
}

/**
 * Check that `psbt`, a stored step's PSBT, is the step's transaction: it
 * spends exactly the step's inputs, each the account's output of the
 * recorded value spent through the account's leaf; a merge pays its single
 * output to the account's own script, and a payment pays the recipient
 * exactly the amount first, memo outputs of no value, and change to the
 * account last when the plan has change; inputs minus outputs are the
 * step's fee; and its id is the step's. And that its fee is what the
 * wallet's own pricing gives it at the step's rate (`qbitSendPlanFeeProblem`),
 * the figures read from the PSBT itself, its inputs and its outputs'
 * scripts: a record changed on disk, however consistent, gets no
 * transaction signed that pays more fee than the planner would have priced
 * at that rate. The rate is the record's, within policy. The spent amounts
 * are the PSBT's own too, and the signature commits to every one of them,
 * so a transaction signed over amounts that are not the real ones is one
 * the network refuses. `txidOf` as for `buildQbitSendPlanSteps`. Throws
 * `QbitSendPlanTransactionMismatchError`.
 */
export function checkQbitSendPlanStepPsbt(
  psbt: Psbt,
  step: QbitSendPlanStepExpectation,
  keys: QbitSendPlanAccountKeys,
  txidOf: (psbt: Psbt) => string
): void {
  const check = (condition: boolean, what: string): void => {
    if (!condition) throw new QbitSendPlanTransactionMismatchError(`${step.kind} ${what}`)
  }
  const summary = decodePsbt(psbt)
  check(summary.inputs.length === step.inputs.length, 'input count')
  summary.inputs.forEach((input, index) => {
    const expected = at(step.inputs, index)
    check(
      displayTxid(input.prevout.txid) === expected.txid && input.prevout.vout === expected.vout,
      `input ${index} outpoint`
    )
    check(
      input.witnessUtxo !== undefined &&
        input.witnessUtxo.value === BigInt(expected.satoshis) &&
        sameBytes(input.witnessUtxo.scriptPubKey, keys.scriptPubKey),
      `input ${index} spent output`
    )
    const [leaf, ...otherLeaves] = input.leafScripts
    check(
      leaf !== undefined &&
        otherLeaves.length === 0 &&
        sameBytes(leaf.script, keys.leafScript) &&
        sameBytes(leaf.controlBlock, keys.controlBlock),
      `input ${index} leaf`
    )
  })
  const outputs = summary.outputs
  if (step.kind === 'merge') {
    const [output, ...otherOutputs] = outputs
    check(
      output !== undefined &&
        otherOutputs.length === 0 &&
        sameBytes(output.scriptPubKey, keys.scriptPubKey) &&
        output.value === BigInt(step.outputValue ?? -1),
      'output'
    )
  } else {
    const recipient = outputs[0]
    check(
      recipient !== undefined &&
        step.recipientScript !== undefined &&
        sameBytes(recipient.scriptPubKey, step.recipientScript) &&
        recipient.value === BigInt(step.amount ?? -1),
      'recipient output'
    )
    const change = step.change ?? 0
    const memoEnd = change > 0 ? outputs.length - 1 : outputs.length
    if (change > 0) {
      const last = outputs[outputs.length - 1]
      check(
        outputs.length >= 2 &&
          last !== undefined &&
          sameBytes(last.scriptPubKey, keys.scriptPubKey) &&
          last.value === BigInt(change),
        'change output'
      )
    }
    for (let index = 1; index < memoEnd; index++) {
      const memo = at(outputs, index)
      // OP_RETURN outputs carry no value.
      check(memo.value === 0n && memo.scriptPubKey[0] === 0x6a, `output ${index}`)
    }
  }
  check(summary.fee === BigInt(step.fee), 'fee')
  const pricing = pricingProblem(
    summary,
    step.kind,
    step.feeRate,
    step.kind === 'payment' && step.target === 'amount' && (step.change ?? 0) === 0,
    keys
  )
  check(pricing === undefined, `${pricing ?? ''} at its rate`)
  check(txidOf(psbt) === step.txid, 'txid')
}

/**
 * What a stored payment's unsigned PSBT says beyond the plan's figures: its
 * memo outputs (every output between the recipient's and the change, which
 * follows them when the plan has change), and whether it signals
 * replaceability. A replan builds its payment with the same.
 */
export function qbitSendPlanPaymentTerms(
  unsignedPsbtHex: string,
  change: number
): { memoOutputs: P2mrTransactionOutput[]; enableRBF: boolean } {
  const summary = decodePsbt(qbitSendPlanPsbtFromHex(unsignedPsbtHex))
  const outputs = summary.outputs.slice(1, change > 0 ? -1 : undefined)
  return {
    memoOutputs: outputs.map(output => ({
      value: output.value,
      scriptPubKey: new Uint8Array(output.scriptPubKey),
    })),
    enableRBF: summary.inputs[0]?.sequence === QBIT_SEND_PLAN_RBF_SEQUENCE,
  }
}

/** Whether two lists of outputs are the same outputs, in the same order. */
export function sameQbitSendPlanOutputs(
  left: readonly P2mrTransactionOutput[],
  right: readonly P2mrTransactionOutput[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (output, index) =>
        output.value === at(right, index).value &&
        sameBytes(output.scriptPubKey, at(right, index).scriptPubKey)
    )
  )
}

/**
 * `signedPsbt` finalized, and the raw transaction a broadcast sends. Throws
 * when it cannot be finalized.
 */
export function qbitSendPlanSignedTransaction(signedPsbt: Psbt): {
  finalized: Psbt
  rawtx: string
} {
  const finalized = finalizeP2mrPsbt(signedPsbt)
  return { finalized, rawtx: bytesToHex(extractP2mrTransaction(finalized)) }
}

/** A stored step, as far as the checks of its transactions read it. */
export interface QbitSendPlanCheckedStep {
  kind: 'merge' | 'payment'
  txid: string
  unsignedPsbtHex: string
  inputs: readonly QbitSendPlanStepInput[]
  fee: number
  feeRate: number
  outputValue?: number
  signedPsbtHex?: string
}

/** A stored plan, as far as the checks of its transactions read it. */
export interface QbitSendPlanCheckedRecord {
  chain: ChainType
  account: { address: string; pubkey: string }
  recipient: string
  target: 'amount' | 'everything'
  amount: number
  change: number
  steps: readonly QbitSendPlanCheckedStep[]
  /** Earlier versions of the payment: each over exactly the payment's inputs. */
  earlierPayments?: readonly {
    txid: string
    unsignedPsbtHex: string
    fee: number
    feeRate: number
    amount: number
    change: number
  }[]
}

/**
 * What `step`'s PSBT must be, from `record`: a merge its inputs, fee and
 * output value at its rate; the payment its inputs, fee and rate, the
 * recipient's script on the plan's network, the amount, the change and the
 * target.
 */
export function qbitSendPlanStepExpectation(
  record: QbitSendPlanCheckedRecord,
  step: QbitSendPlanCheckedStep
): QbitSendPlanStepExpectation {
  return step.kind === 'merge'
    ? {
        kind: 'merge',
        txid: step.txid,
        inputs: step.inputs,
        fee: step.fee,
        feeRate: step.feeRate,
        ...(step.outputValue !== undefined ? { outputValue: step.outputValue } : {}),
      }
    : {
        kind: 'payment',
        txid: step.txid,
        inputs: step.inputs,
        fee: step.fee,
        feeRate: step.feeRate,
        recipientScript: qbitSendPlanAddressScript(record.chain, record.recipient),
        amount: record.amount,
        change: record.change,
        target: record.target,
      }
}

/**
 * The account's single-key spend, once `record`'s account address is the
 * address of its public key on the plan's network: every output the plan
 * pays the account (a merge's, the change) pays that address. Throws
 * `QbitSendPlanTransactionMismatchError` otherwise.
 */
export function qbitSendPlanRecordKeys(record: QbitSendPlanCheckedRecord): QbitSendPlanAccountKeys {
  let keys: QbitSendPlanAccountKeys
  try {
    keys = qbitSendPlanAccountKeys(record.account.pubkey)
  } catch {
    throw new QbitSendPlanTransactionMismatchError('the account key')
  }
  if (
    !sameBytes(qbitSendPlanAddressScript(record.chain, record.account.address), keys.scriptPubKey)
  ) {
    throw new QbitSendPlanTransactionMismatchError('the account address is not its key’s')
  }
  return keys
}

/**
 * The raw transaction a broadcast of a stored signed payment sends, once
 * `signedPsbtHex` is the very transaction `unsignedPsbtHex` holds: the same
 * unsigned transaction, byte for byte (the same version, inputs, sequences,
 * outputs and lock time, so the same id), with every input finalized. The
 * raw transaction is built from that unsigned transaction and the final
 * witnesses alone (`extractP2mrTransaction`), so what goes out pays exactly
 * the outputs of `unsignedPsbtHex`. Throws
 * `QbitSendPlanTransactionMismatchError` otherwise.
 */
export function qbitSendPlanSignedPayment(
  unsignedPsbtHex: string,
  signedPsbtHex: string
): { psbt: Psbt; rawtx: string } {
  let signed: Psbt
  let unsigned: Psbt
  try {
    signed = qbitSendPlanPsbtFromHex(signedPsbtHex)
    unsigned = qbitSendPlanPsbtFromHex(unsignedPsbtHex)
  } catch {
    throw new QbitSendPlanTransactionMismatchError('payment signed bytes: not a PSBT')
  }
  if (!sameBytes(unsignedTransactionBytes(signed), unsignedTransactionBytes(unsigned))) {
    throw new QbitSendPlanTransactionMismatchError('payment signed bytes: another transaction')
  }
  let rawtx: string
  try {
    if (!decodePsbt(signed).inputs.every(input => input.finalized)) throw new Error()
    rawtx = bytesToHex(extractP2mrTransaction(signed))
  } catch {
    throw new QbitSendPlanTransactionMismatchError('payment signed bytes: not finalized')
  }
  return { psbt: signed, rawtx }
}

/**
 * Check every transaction `record` stores against what the record states:
 * its account address is its key's (`qbitSendPlanRecordKeys`); every step's
 * unsigned PSBT is that step's transaction, priced as the wallet prices one
 * (`checkQbitSendPlanStepPsbt`, the check made before each signature, with
 * the recipient's script on the plan's network); and the payment's signed
 * bytes, when stored, are that same transaction (`qbitSendPlanSignedPayment`).
 * So the recipient, amount, change and fees a record shows are what its
 * transactions pay, its signed payment included, and nothing else of value.
 * Every earlier version of the payment is a payment of the same recipient,
 * at the amount, change and rate it records, over exactly the payment's
 * inputs in the same order, under its own id. The inputs are compared as a
 * list, not as a set: a version found in the network completes the plan
 * with the payment's input list, which must describe that version's
 * transaction input by input, and the engine builds each version over the
 * inputs of the one it replaces, in their order. Throws
 * `QbitSendPlanTransactionMismatchError`, naming the step and the figure
 * that differs.
 */
export function checkQbitSendPlanTransactions(record: QbitSendPlanCheckedRecord): void {
  const keys = qbitSendPlanRecordKeys(record)
  qbitSendPlanAddressScript(record.chain, record.recipient)
  record.steps.forEach((step, index) => {
    const path = `steps[${index}]`
    let psbt: Psbt
    try {
      psbt = qbitSendPlanPsbtFromHex(step.unsignedPsbtHex)
    } catch {
      throw new QbitSendPlanTransactionMismatchError(`${path}: not a PSBT`)
    }
    try {
      checkQbitSendPlanStepPsbt(
        psbt,
        qbitSendPlanStepExpectation(record, step),
        keys,
        qbitSendPlanTxid
      )
      if (step.signedPsbtHex !== undefined) {
        qbitSendPlanSignedPayment(step.unsignedPsbtHex, step.signedPsbtHex)
      }
    } catch (error) {
      if (error instanceof QbitSendPlanTransactionMismatchError) {
        throw new QbitSendPlanTransactionMismatchError(`${path}: ${error.what}`)
      }
      throw new QbitSendPlanTransactionMismatchError(`${path}: not the step's transaction`)
    }
  })
  const payment = record.steps[record.steps.length - 1]
  ;(record.earlierPayments ?? []).forEach((version, index) => {
    const path = `earlierPayments[${index}]`
    if (!payment) throw new QbitSendPlanTransactionMismatchError(`${path}: no payment`)
    try {
      checkQbitSendPlanStepPsbt(
        qbitSendPlanPsbtFromHex(version.unsignedPsbtHex),
        {
          kind: 'payment',
          txid: version.txid,
          inputs: payment.inputs,
          fee: version.fee,
          feeRate: version.feeRate,
          recipientScript: qbitSendPlanAddressScript(record.chain, record.recipient),
          amount: version.amount,
          change: version.change,
          target: record.target,
        },
        keys,
        qbitSendPlanTxid
      )
    } catch (error) {
      if (error instanceof QbitSendPlanTransactionMismatchError) {
        throw new QbitSendPlanTransactionMismatchError(`${path}: ${error.what}`)
      }
      throw new QbitSendPlanTransactionMismatchError(`${path}: not a version of the payment`)
    }
  })
}

/**
 * The raw transaction a broadcast of `record`'s stored signed payment sends,
 * checked immediately before it goes: the payment's unsigned PSBT is the
 * payment the record states (`checkQbitSendPlanStepPsbt`: the recipient's
 * script on the plan's network, the amount, the change to the account's
 * address, nothing else of value, and the fee at its rate), and the signed
 * bytes are that same transaction (`qbitSendPlanSignedPayment`). Throws
 * `QbitSendPlanTransactionMismatchError` otherwise, and when no signed
 * payment is stored.
 */
export function qbitSendPlanStoredPayment(record: QbitSendPlanCheckedRecord): {
  psbt: Psbt
  rawtx: string
} {
  const payment = record.steps[record.steps.length - 1]
  if (payment?.kind !== 'payment' || payment.signedPsbtHex === undefined) {
    throw new QbitSendPlanTransactionMismatchError('no signed payment is stored')
  }
  const keys = qbitSendPlanRecordKeys(record)
  try {
    checkQbitSendPlanStepPsbt(
      qbitSendPlanPsbtFromHex(payment.unsignedPsbtHex),
      qbitSendPlanStepExpectation(record, payment),
      keys,
      qbitSendPlanTxid
    )
  } catch (error) {
    if (error instanceof QbitSendPlanTransactionMismatchError) throw error
    throw new QbitSendPlanTransactionMismatchError("payment: not the step's transaction")
  }
  return qbitSendPlanSignedPayment(payment.unsignedPsbtHex, payment.signedPsbtHex)
}
