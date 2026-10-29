import {
  assessQbitFee,
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
   * not build: a fee that is a large share of what it pays others is then
   * flagged whatever that rate says (see `assessQbitFee`).
   */
  checkFeeShareWithoutSize?: boolean
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
 * Throws a RangeError when an amount is not a safe integer.
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

  let walletOutputValue = 0
  let externalOutputValue = 0
  let unrecognisedOutputCount = 0
  let unrecognisedOutputValue = 0
  let undecodableOutputCount = 0
  const outputRoles = outputs.map((output): PsbtOutputRole => {
    if (output.type === 'op_return') {
      externalOutputValue = addSafe(externalOutputValue, output.value, 'output')
      return 'data'
    }
    if (qbitWalletOwns(wallet, output)) {
      walletOutputValue = addSafe(walletOutputValue, output.value, 'output')
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
  // The fee is compared with what the transaction pays others only when the
  // wallet funds all of it; with another party's inputs neither the fee nor
  // those payments are the wallet's alone, so only the rate is judged. A
  // partial PSBT whose outputs exceed its inputs (others add inputs later)
  // has no fee to judge yet.
  const feeAssessment =
    known && fee >= 0
      ? assessQbitFee({
          fee,
          feeRate,
          amount: otherPartyInputValue > 0 ? 0 : externalOutputValue,
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
    risks.push({
      type: RiskType.HIGH_FEE_RATE,
      level: 'warning',
      title: 'High fee rate detected',
      desc: 'The fee is far above what this transaction needs.',
    })
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
