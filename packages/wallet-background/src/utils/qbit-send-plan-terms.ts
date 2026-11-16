import { bytesToHex } from '@qbit-oss/protocol'
import { transactionCore } from '@qbit/wallet-core'
import {
  QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE,
  QBIT_SEND_PLAN_TERMS_DIGEST_PATTERN,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'

/**
 * What a send plan's view states of its terms (`QbitSendPlanView.termsDigest`):
 * everything that names the plan and the transactions a Continue lets the
 * background sign and send, and nothing of how far they got (no step's
 * status, no phase, pause, action or signing progress, no time).
 */
export type QbitSendPlanTerms = Pick<
  QbitSendPlanView,
  | 'id'
  | 'chain'
  | 'address'
  | 'recipient'
  | 'target'
  | 'amount'
  | 'change'
  | 'feeRate'
  | 'totalFee'
  | 'signaturesTotal'
  | 'paymentTxid'
> & {
  steps: readonly Pick<QbitSendPlanView['steps'][number], 'kind' | 'txid' | 'inputCount' | 'fee'>[]
}

/** Names the encoding below, so that another one never yields the same digest. */
const TERMS_ENCODING = 'qbit-send-plan-terms/1'

/**
 * The digest of `terms` as a view states them: SHA-256, as lower-case hex,
 * of one JSON array holding the encoding's name and each term in a fixed
 * order, every transaction as its kind, id, input count and fee. A JSON
 * array has one serialization for given values: every figure is a number
 * that JSON writes one way, and every other term a string. Only the
 * background makes it; a page carries it back unread.
 */
export function qbitSendPlanTermsDigest(terms: QbitSendPlanTerms): string {
  const encoded = JSON.stringify([
    TERMS_ENCODING,
    terms.id,
    terms.chain,
    terms.address,
    terms.recipient,
    terms.target,
    terms.amount,
    terms.change,
    terms.feeRate,
    terms.totalFee,
    terms.signaturesTotal,
    terms.paymentTxid,
    terms.steps.map(step => [step.kind, step.txid, step.inputCount, step.fee]),
  ])
  return bytesToHex(transactionCore.crypto.sha256(Buffer.from(encoded, 'utf8')))
}

/**
 * The terms digest a Continue names, as it crossed the UI port: a string of
 * exactly the form the background makes (`QBIT_SEND_PLAN_TERMS_DIGEST_PATTERN`).
 * Throws for anything else: missing (`undefined`), `null` (how an explicit
 * `undefined`, NaN and ±Infinity arrive), a number, another string, an
 * object. None of them is read as "whatever is stored".
 */
export function readQbitSendPlanTermsDigest(value: unknown): string {
  if (typeof value !== 'string' || !QBIT_SEND_PLAN_TERMS_DIGEST_PATTERN.test(value)) {
    throw new TypeError('termsDigest must be the terms digest of the Qbit send plan view shown')
  }
  return value
}

/**
 * A continue refused because the plan stored does not state the terms of
 * the view it names (`QbitSendPlanView.termsDigest`). Its `code` crosses
 * the UI port with its message, so a page can tell it from other
 * failures: it reads the plan again and shows what is stored.
 */
export class QbitSendPlanNotAsShownError extends Error {
  readonly code = QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE

  constructor() {
    super('The Qbit send plan changed since it was shown: read it again before continuing')
    this.name = 'QbitSendPlanNotAsShownError'
  }
}
