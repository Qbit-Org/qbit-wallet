import {
  assessQbitFee,
  QBIT_P2A_MAX_VALUE,
  qbitRecommendedFeeRate,
  qbitWalletOwns,
  RiskType,
  type DecodedPsbtInput,
  type DecodedPsbtOutput,
  type FeeSummary,
  type PsbtOutputRole,
  type PsbtSpendSummary,
  type QbitWalletOwnership,
  type Risk,
} from '@qbit/wallet-shared'

export interface QbitPsbtSpendSummaryParams {
  inputs: readonly DecodedPsbtInput[]
  outputs: readonly DecodedPsbtOutput[]
  /** Exact fee in bits; only meaningful when `isCompleted`. */
  fee: number
  feeRate: number
  /** Every input carries its spent output, so its owner, value and the fee are known. */
  isCompleted: boolean
  account: string
  wallet: QbitWalletOwnership
  statedRecipients?: readonly string[] | undefined
  /** The current quote; without live rates the fee is checked against the wallet's own bounds only. */
  feeSummary?: FeeSummary | undefined
  /**
   * Set for a website's PSBT, whose `feeRate` rests on a size the wallet did
   * not build: a fee that is a large share of what it pays others, or of what
   * leaves the wallet when other parties fund some of its inputs, is then
   * flagged whatever that rate says (see `assessQbitFee`).
   */
  checkFeeShareWithoutSize?: boolean
  /**
   * The outputs the wallet's `SIGHASH_SINGLE` signatures lock in, each with
   * the value of the input that signs it. Every such signature can be used
   * without the others, so the wallet is credited an output only up to its
   * own input's value, and not at all for an output no signature locks in:
   * whoever holds the signatures can replace those. Then `netSpend` is the
   * most that can leave the wallet. A lock whose input is not the wallet's
   * credits nothing (`walletOwnedLocks`), but it is still a signature that
   * leaves the other outputs open. Empty when no input is signed that way.
   */
  lockedOutputs?: ReadonlyMap<number, number>
  /**
   * Set when the wallet signs an input under `SIGHASH_ALL|ANYONECANPAY`
   * (0x81), or under a type that fixes no output at all. A 0x81 signature
   * fixes every output but none of the other inputs, so it can be joined, in
   * one transaction, with a signature of its kind
   * from another approval of the same outputs: the wallet's outputs are then
   * paid once for both inputs. No output is credited on its account, only
   * what `lockedOutputs` gives, and `netSpend` stays the most that can leave
   * the wallet however many such approvals there are.
   */
  anyoneCanPayAll?: boolean
}

/**
 * The locks a `SIGHASH_SINGLE` signature really gives the wallet: those whose
 * input spends an output the wallet owns. A signed input that is not the
 * wallet's, such as a shared output the account's leaf can spend, locks an
 * output without putting any of the wallet's value behind it, so crediting
 * that output would net against value that is not at risk.
 */
export function walletOwnedLocks(
  inputs: readonly DecodedPsbtInput[],
  wallet: QbitWalletOwnership,
  lockedOutputs: ReadonlyMap<number, number>
): Map<number, number> {
  const owned = new Map<number, number>()
  for (const [index, cap] of lockedOutputs) {
    const input = inputs[index]
    if (
      input?.witnessUtxoScriptHex !== undefined &&
      qbitWalletOwns(wallet, {
        scriptPubKeyHex: input.witnessUtxoScriptHex,
        address: input.address,
      })
    ) {
      owned.set(index, cap)
    }
  }
  return owned
}

function addSafe(total: number, value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
    throw new RangeError(`PSBT ${label} value is not a safe amount`)
  }
  return total + value
}

/**
 * Summarize what a decoded PSBT does to the wallet, and the risks that must
 * gate signing it: an abnormal fee, an output with no address the wallet can
 * show, or an output beside the named recipient in a request that names one.
 * Pay-to-anchor outputs that carry no more than `QBIT_P2A_MAX_VALUE` together
 * are fee anchors: they raise no unrecognised-output risk, and their value
 * counts as paid to others. Throws a RangeError when an amount is not a safe
 * integer.
 */
export function summarizeQbitPsbtSpend({
  inputs,
  outputs,
  fee,
  feeRate,
  isCompleted,
  account,
  wallet,
  statedRecipients = [],
  feeSummary,
  checkFeeShareWithoutSize = false,
  lockedOutputs: signedLocks = new Map<number, number>(),
  anyoneCanPayAll = false,
}: QbitPsbtSpendSummaryParams): {
  spendSummary: PsbtSpendSummary
  risks: Risk[]
  recommendedFeeRate?: number
} {
  const recommendedFeeRate = qbitRecommendedFeeRate(feeSummary)
  if (
    !Array.isArray(statedRecipients) ||
    !statedRecipients.every(address => typeof address === 'string')
  ) {
    throw new TypeError('statedRecipients must be an array of addresses')
  }
  if (typeof checkFeeShareWithoutSize !== 'boolean') {
    throw new TypeError('checkFeeShareWithoutSize must be a boolean')
  }
  if (typeof anyoneCanPayAll !== 'boolean') {
    throw new TypeError('anyoneCanPayAll must be a boolean')
  }
  const recipients = new Set(
    statedRecipients.filter(address => address !== '').map(address => address.toLowerCase())
  )

  let walletInputValue = 0
  let otherPartyInputValue = 0
  let allInputsKnown = true
  for (const input of inputs) {
    if (input.witnessUtxoScriptHex === undefined) {
      allInputsKnown = false
      continue
    }
    if (
      qbitWalletOwns(wallet, {
        scriptPubKeyHex: input.witnessUtxoScriptHex,
        address: input.address,
      })
    ) {
      walletInputValue = addSafe(walletInputValue, input.value, 'input')
    } else {
      otherPartyInputValue = addSafe(otherPartyInputValue, input.value, 'input')
    }
  }

  const lockedOutputs = walletOwnedLocks(inputs, wallet, signedLocks)
  let walletOutputValue = 0
  // What a partial signature leaves out of `walletOutputValue`: it counts as
  // paid to others below, but the fee is judged as if every output were the
  // transaction's.
  let uncreditedWalletOutputValue = 0
  let externalOutputValue = 0
  let unrecognisedOutputCount = 0
  let unrecognisedOutputValue = 0
  let undecodableOutputCount = 0
  const anchorValue = outputs.reduce(
    (total, output) => (output.type === 'p2a' ? addSafe(total, output.value, 'output') : total),
    0
  )
  const anchorsWithinBound = anchorValue <= QBIT_P2A_MAX_VALUE
  const outputRoles = outputs.map((output, index): PsbtOutputRole => {
    if (output.type === 'op_return') {
      externalOutputValue = addSafe(externalOutputValue, output.value, 'output')
      return 'data'
    }
    if (output.type === 'p2a' && anchorsWithinBound) {
      externalOutputValue = addSafe(externalOutputValue, output.value, 'output')
      return 'anchor'
    }
    if (qbitWalletOwns(wallet, output)) {
      // Every output counts only when the wallet's signatures cover the
      // whole transaction. One under `SIGHASH_SINGLE`, even on an input the
      // wallet does not own, leaves the outputs it does not lock in open,
      // and one under 0x81 can share its outputs with another approval's.
      const credited =
        signedLocks.size === 0 && !anyoneCanPayAll
          ? output.value
          : Math.min(output.value, lockedOutputs.get(index) ?? 0)
      walletOutputValue = addSafe(walletOutputValue, credited, 'output')
      if (credited < output.value) {
        externalOutputValue = addSafe(externalOutputValue, output.value - credited, 'output')
        uncreditedWalletOutputValue = addSafe(
          uncreditedWalletOutputValue,
          output.value - credited,
          'output'
        )
      }
      return 'wallet'
    }
    externalOutputValue = addSafe(externalOutputValue, output.value, 'output')
    if (output.address !== '' && recipients.has(output.address.toLowerCase())) {
      return 'recipient'
    }
    unrecognisedOutputCount++
    unrecognisedOutputValue = addSafe(unrecognisedOutputValue, output.value, 'output')
    if (output.address === '') undecodableOutputCount++
    return 'unrecognised'
  })

  const known = isCompleted && allInputsKnown
  // The fee is compared with what the transaction pays others when the
  // wallet funds all of it. With another party's inputs neither the fee nor
  // those payments are the wallet's alone: the wallet's own screens judge only
  // the rate, and a website's PSBT, whose rate rests on a size the wallet did
  // not build, compares the fee with what leaves the wallet when every output
  // is paid as written. Nothing to compare with means nothing but the fee
  // leaves the wallet. A partial PSBT whose outputs exceed its inputs (others
  // add inputs later) has no fee to judge yet.
  const comparedAmount =
    otherPartyInputValue === 0
      ? externalOutputValue - uncreditedWalletOutputValue
      : checkFeeShareWithoutSize
        ? Math.max(0, walletInputValue - walletOutputValue - uncreditedWalletOutputValue)
        : 0
  const feeAssessment =
    known && fee >= 0
      ? assessQbitFee({
          fee,
          feeRate,
          amount: comparedAmount,
          recommendedFeeRate,
          checkFeeShareWithoutSize,
        })
      : undefined

  const spendSummary: PsbtSpendSummary = {
    account,
    walletInputValue,
    walletOutputValue,
    ...(known ? { netSpend: walletInputValue - walletOutputValue } : {}),
    externalOutputValue,
    outputRoles,
    unrecognisedOutputCount,
    unrecognisedOutputValue,
    undecodableOutputCount,
    ...(feeAssessment ? { feeAssessment } : {}),
  }

  const risks: Risk[] = []
  if (feeAssessment && feeAssessment.reasons.length > 0) {
    risks.push(
      feeAssessment.highFeeAtNormalRate
        ? {
            type: RiskType.HIGH_FEE_RATE,
            level: 'warning',
            title: 'High fee detected',
            desc: 'The fee is a large share of what this transaction sends.',
          }
        : {
            type: RiskType.HIGH_FEE_RATE,
            level: 'warning',
            title: 'High fee rate detected',
            desc: 'The fee is far above what this transaction needs.',
          }
    )
  }
  if (undecodableOutputCount > 0 || (recipients.size > 0 && unrecognisedOutputCount > 0)) {
    risks.push({
      type: RiskType.UNRECOGNISED_OUTPUT,
      level: 'danger',
      title: 'Unrecognised output',
      desc: 'An output pays a script that is neither yours nor the named recipient.',
    })
  }

  return {
    spendSummary,
    risks,
    ...(recommendedFeeRate !== undefined ? { recommendedFeeRate } : {}),
  }
}
