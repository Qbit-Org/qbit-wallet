import type { QbitSendPlanReview, QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

/** The harness's selected account (`createTestStore`) on its default network. */
export const PLAN_ACCOUNT = 'qb1ztestaccount'
export const PLAN_CHAIN = ChainType.QBIT_MAINNET
export const PLAN_RECIPIENT = 'qb1zrecipient0000000000000000000000000000000000000000000'

/** A plan of the harness's account: one merge, then the payment, still signing. */
export function planView(overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView {
  return {
    id: 'plan-1',
    chain: PLAN_CHAIN,
    address: PLAN_ACCOUNT,
    recipient: PLAN_RECIPIENT,
    target: 'amount',
    amount: 1_000_000,
    change: 5_000,
    feeRate: 1,
    totalFee: 588_827,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'planned' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'planned' },
    ],
    sent: false,
    phase: 'signing',
    actions: ['cancel'],
    signing: { step: 0, signed: 0, total: 106 },
    signaturesDone: 0,
    signaturesTotal: 156,
    paymentTxid: 'bb'.repeat(32),
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    ...overrides,
  }
}

/**
 * What the background answers for a stored plan it cannot read (a corrupt
 * record, or one another version wrote), for the harness's account: the
 * literal of `QbitSendPlanEngine.unreadableView` in
 * `packages/wallet-background/src/services/qbitSendPlanEngine.ts`, copied
 * field for field. `id` is the stored entry's own id, or `unreadable` when it
 * has none or the whole document cannot be read.
 */
export function unreadablePlanView(id = 'unreadable'): QbitSendPlanView {
  return {
    id,
    chain: PLAN_CHAIN,
    address: PLAN_ACCOUNT,
    recipient: '',
    target: 'amount',
    amount: 0,
    change: 0,
    feeRate: 0,
    totalFee: 0,
    steps: [],
    sent: false,
    phase: 'paused',
    pause: { reason: 'unreadable' },
    actions: ['cancel'],
    signaturesDone: 0,
    signaturesTotal: 0,
    paymentTxid: '',
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
  }
}

/**
 * What the background answers for a stored plan whose step failed its
 * check before a signature (`QbitSendPlanEngine.signStep` pauses it
 * `unreadable`; `viewOf` sends it with every figure its record states), for
 * the harness's account: the views `world.plan()` answers in
 * `packages/wallet-background/test/qbit-send-plan-engine-fees.test.ts`,
 * copied field for field but for the account and network. `merge`: "pauses
 * unreadable, with only cancel, a plan whose merge PSBT is not the
 * transaction its record states, signing nothing". `payment`: "pauses
 * unreadable at the payment whose PSBT pays more fee than its record, once
 * the merges went out", where the merge was signed and sent.
 */
export function refusedPlanView(at: 'merge' | 'payment'): QbitSendPlanView {
  const merge = at === 'merge'
  return {
    id: merge ? 'ab081e5aa6c3d2193bef472f3a5f2433' : 'cb7ba66b33c87b38d135d842fdd66535',
    chain: PLAN_CHAIN,
    address: PLAN_ACCOUNT,
    recipient: 'qbrt1zqkcyafpvy2hf7474n3a4lz2qsmf3hg2584xetayz895ry280jams3fatcm',
    target: 'amount',
    amount: 12_000_000,
    change: 25_835,
    feeRate: 1,
    totalFee: 474_165,
    steps: [
      {
        kind: 'merge',
        txid: '3f2d0e50dfe14c041bba9250f9d58a7d3acd14528dac2b453091083d998943b6',
        inputCount: 106,
        fee: 398_827,
        status: merge ? 'planned' : 'broadcast',
      },
      {
        kind: 'payment',
        txid: 'c2781d33f80f9b4296921e0ce19ca9f0d9f3072da28acef92d00c9b85a067372',
        inputCount: 20,
        fee: 75_338,
        status: 'planned',
      },
    ],
    sent: !merge,
    phase: 'paused',
    pause: {
      reason: 'unreadable',
      detail: `Qbit send plan transaction does not match its plan: ${
        merge ? 'merge output' : 'payment change output'
      }`,
    },
    actions: ['cancel'],
    signaturesDone: merge ? 0 : 106,
    signaturesTotal: 126,
    paymentTxid: 'c2781d33f80f9b4296921e0ce19ca9f0d9f3072da28acef92d00c9b85a067372',
    createdAt: 1_762_000_000_000,
    updatedAt: 1_762_000_000_000,
    revision: merge ? 5_000_000 : 7_000_000,
  }
}

/**
 * A plan paused `unreadable` as the page shows it (`readQbitSendPlanView`),
 * from `view`, the background's answer for it: the stand-in's fields, with
 * the plan's own id, pause, `sent`, times and revision.
 */
export function unreadableShown(view: QbitSendPlanView): QbitSendPlanView {
  return {
    ...unreadablePlanView(view.id),
    sent: view.sent,
    pause: view.pause,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    revision: view.revision,
  }
}

/** A review of a new plan for the harness's account, valid for an hour. */
export function planReview(overrides: Partial<QbitSendPlanReview> = {}): QbitSendPlanReview {
  return {
    draftId: 'draft-1',
    chain: PLAN_CHAIN,
    address: PLAN_ACCOUNT,
    recipient: PLAN_RECIPIENT,
    target: 'amount',
    amount: 1_000_000,
    change: 5_000,
    feeRate: 1,
    totalFee: 588_827,
    paidFee: 0,
    merges: [{ inputCount: 106, fee: 398_827 }],
    payment: { inputCount: 50, fee: 190_000, txid: 'bb'.repeat(32) },
    signatureCount: 156,
    signatureBudget: {
      required: 156,
      cached: 0,
      remainingBefore: 1_073_741_824,
      remainingAfter: 1_073_741_668,
      limit: 1_073_741_824,
    },
    estimatedSigningSeconds: 201,
    leftBehindSatoshis: 0,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  }
}

/** A promise with its settle functions, to land answers in a chosen order. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
