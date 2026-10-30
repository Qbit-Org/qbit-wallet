import { describe, expect, it } from 'vitest'

import {
  RiskType,
  qbitWalletOwnership,
  type DecodedPsbtInput,
  type DecodedPsbtOutput,
} from '@qbit/wallet-shared'

import {
  summarizeQbitPsbtSpend,
  type QbitPsbtSpendSummaryParams,
} from '../src/utils/qbit-psbt-spend-summary'

const OWN_SCRIPT = '5120' + 'aa'.repeat(32)
const OTHER_ACCOUNT_SCRIPT = '5120' + 'bb'.repeat(32)
const MERCHANT_SCRIPT = '5120' + 'cc'.repeat(32)
const STRANGER_SCRIPT = '5120' + 'dd'.repeat(32)

const LIVE_QUOTE = {
  list: [
    { title: 'Slow', desc: '', feeRate: 1 },
    { title: 'Normal', desc: '', feeRate: 1 },
    { title: 'Fast', desc: '', feeRate: 2 },
  ],
  quote: {
    source: 'mempool-qbit' as const,
    availability: 'available' as const,
    freshness: 'live' as const,
  },
}

const WALLET = qbitWalletOwnership([
  {
    type: 'Qbit HD Key Tree',
    pubkey: 'aa',
    address: 'qbrt1zown',
    key: 'own',
    flag: 0,
    p2mr: { scriptPubKey: OWN_SCRIPT.toUpperCase(), addresses: { regtest: 'qbrt1zown' } },
  },
  {
    type: 'Qbit HD Key Tree',
    pubkey: 'bb',
    address: 'qbrt1zother',
    key: 'other',
    flag: 0,
    p2mr: { scriptPubKey: OTHER_ACCOUNT_SCRIPT, addresses: { regtest: 'qbrt1zother' } },
  },
] as never)

function input(scriptHex: string | undefined, value: number, address = ''): DecodedPsbtInput {
  return {
    txid: '11'.repeat(32),
    vout: 0,
    address,
    value,
    sighashType: 0,
    ...(scriptHex === undefined ? {} : { witnessUtxoScriptHex: scriptHex }),
  }
}

function output(scriptHex: string, value: number, address: string): DecodedPsbtOutput {
  return { address, value, scriptPubKeyHex: scriptHex }
}

function params(overrides: Partial<QbitPsbtSpendSummaryParams> = {}): QbitPsbtSpendSummaryParams {
  return {
    inputs: [input(OWN_SCRIPT, 1_000_000, 'qbrt1zown')],
    outputs: [
      output(MERCHANT_SCRIPT, 10_000, 'qbrt1zmerchant'),
      output(OWN_SCRIPT, 986_140, 'qbrt1zown'),
    ],
    fee: 3_860,
    feeRate: 1,
    isCompleted: true,
    account: 'qbrt1zown',
    wallet: WALLET,
    statedRecipients: ['QBRT1ZMERCHANT'],
    feeSummary: LIVE_QUOTE,
    ...overrides,
  }
}

describe('qbit PSBT spend summary', () => {
  it('reports the amount leaving the wallet as the inputs it spends less the change back to it', () => {
    const { spendSummary, risks, recommendedFeeRate } = summarizeQbitPsbtSpend(params())
    expect(spendSummary).toEqual({
      account: 'qbrt1zown',
      walletInputValue: 1_000_000,
      walletOutputValue: 986_140,
      netSpend: 13_860,
      externalOutputValue: 10_000,
      outputRoles: ['recipient', 'wallet'],
      unrecognisedOutputCount: 0,
      unrecognisedOutputValue: 0,
      undecodableOutputCount: 0,
      feeAssessment: {
        fee: 3_860,
        feeRate: 1,
        amount: 10_000,
        recommendedFeeRate: 2,
        reasons: [],
      },
    })
    expect(risks).toEqual([])
    expect(recommendedFeeRate).toBe(2)
  })

  it('shows the large unfamiliar output a dapp PSBT hides beside a small merchant output', () => {
    // WS3 scenario: a small payment, a large output to an unfamiliar address
    // and the rest back to the account. Nothing in the request names a
    // recipient, so both are unrecognised; the net spend shows the total.
    const { spendSummary, risks } = summarizeQbitPsbtSpend(
      params({
        outputs: [
          output(MERCHANT_SCRIPT, 10_000, 'qbrt1zmerchant'),
          output(STRANGER_SCRIPT, 900_000, 'qbrt1zstranger'),
          output(OWN_SCRIPT, 86_140, 'qbrt1zown'),
        ],
        statedRecipients: [],
      })
    )
    expect(spendSummary.netSpend).toBe(913_860)
    expect(spendSummary.outputRoles).toEqual(['unrecognised', 'unrecognised', 'wallet'])
    expect(spendSummary.unrecognisedOutputCount).toBe(2)
    expect(spendSummary.unrecognisedOutputValue).toBe(910_000)
    // Flagged, but a dapp's own payees are not a signing risk by themselves.
    expect(risks).toEqual([])
  })

  it('gates an output beside the named recipient and one with no address', () => {
    const extra = summarizeQbitPsbtSpend(
      params({
        outputs: [
          output(MERCHANT_SCRIPT, 10_000, 'qbrt1zmerchant'),
          output(STRANGER_SCRIPT, 900_000, 'qbrt1zstranger'),
          output(OWN_SCRIPT, 86_140, 'qbrt1zown'),
        ],
      })
    )
    expect(extra.spendSummary.outputRoles).toEqual(['recipient', 'unrecognised', 'wallet'])
    expect(extra.risks.map(risk => [risk.type, risk.level])).toEqual([
      [RiskType.UNRECOGNISED_OUTPUT, 'danger'],
    ])

    const undecodable = summarizeQbitPsbtSpend(
      params({
        outputs: [output('51', 10_000, ''), output(OWN_SCRIPT, 986_140, 'qbrt1zown')],
        statedRecipients: [],
      })
    )
    expect(undecodable.spendSummary.outputRoles).toEqual(['unrecognised', 'wallet'])
    expect(undecodable.spendSummary.undecodableOutputCount).toBe(1)
    expect(undecodable.risks.map(risk => risk.type)).toEqual([RiskType.UNRECOGNISED_OUTPUT])
  })

  it('does not count a watched address as the wallet', () => {
    const watched = qbitWalletOwnership([
      {
        type: 'Qbit HD Key Tree',
        pubkey: 'aa',
        address: 'qbrt1zown',
        key: 'own',
        flag: 0,
        p2mr: { scriptPubKey: OWN_SCRIPT, addresses: { regtest: 'qbrt1zown' } },
      },
      {
        type: 'Watch Address',
        pubkey: '',
        address: 'qbrt1zstranger',
        key: 'watched',
        flag: 0,
        p2mr: { scriptPubKey: STRANGER_SCRIPT, addresses: { regtest: 'qbrt1zstranger' } },
      },
    ] as never)
    const { spendSummary } = summarizeQbitPsbtSpend(
      params({
        wallet: watched,
        outputs: [
          output(STRANGER_SCRIPT, 900_000, 'qbrt1zstranger'),
          output(OWN_SCRIPT, 96_140, 'qbrt1zown'),
        ],
        statedRecipients: [],
      })
    )
    expect(spendSummary.outputRoles).toEqual(['unrecognised', 'wallet'])
    expect(spendSummary.netSpend).toBe(903_860)
  })

  it('counts another of the wallet’s accounts as the wallet, and data outputs as sent', () => {
    const { spendSummary } = summarizeQbitPsbtSpend(
      params({
        outputs: [
          output(OTHER_ACCOUNT_SCRIPT, 500_000, 'qbrt1zother'),
          {
            type: 'op_return',
            address: '',
            value: 0,
            scriptPubKeyHex: '6a0568656c6c6f',
            opReturn: { scriptPubKeyHex: '6a0568656c6c6f', chunks: [] },
          },
          output(OWN_SCRIPT, 496_140, 'qbrt1zown'),
        ],
        statedRecipients: [],
      })
    )
    expect(spendSummary.outputRoles).toEqual(['wallet', 'data', 'wallet'])
    expect(spendSummary.netSpend).toBe(3_860)
    expect(spendSummary.externalOutputValue).toBe(0)
    expect(spendSummary.feeAssessment?.amount).toBe(0)
  })

  it('reports a net gain when the wallet receives more than it spends', () => {
    const { spendSummary } = summarizeQbitPsbtSpend(
      params({
        inputs: [input(STRANGER_SCRIPT, 600_000, 'qbrt1zstranger'), input(OWN_SCRIPT, 10_000)],
        outputs: [
          output(OWN_SCRIPT, 500_000, 'qbrt1zown'),
          output(STRANGER_SCRIPT, 106_140, 'qbrt1zstranger'),
        ],
        statedRecipients: [],
      })
    )
    expect(spendSummary.walletInputValue).toBe(10_000)
    expect(spendSummary.netSpend).toBe(-490_000)
  })

  it('judges only the rate of a fee other parties help fund', () => {
    // A marketplace PSBT: the counterparty's input pays most of a high fee.
    const { spendSummary, risks } = summarizeQbitPsbtSpend(
      params({
        inputs: [input(STRANGER_SCRIPT, 600_000, 'qbrt1zstranger'), input(OWN_SCRIPT, 10_000)],
        outputs: [
          output(OWN_SCRIPT, 500_000, 'qbrt1zown'),
          output(MERCHANT_SCRIPT, 10_000, 'qbrt1zmerchant'),
        ],
        fee: 100_000,
        feeRate: 25,
        statedRecipients: [],
      })
    )
    expect(spendSummary.feeAssessment).toMatchObject({
      amount: 0,
      reasons: ['above_recommended_rate'],
    })
    expect(risks.map(risk => risk.type)).toEqual([RiskType.HIGH_FEE_RATE])
  })

  it('has no fee to judge on a partial PSBT whose outputs exceed its inputs', () => {
    // A listing signed for a buyer who adds the inputs that pay for it later.
    const { spendSummary, risks } = summarizeQbitPsbtSpend(
      params({
        inputs: [input(OWN_SCRIPT, 10_000, 'qbrt1zown')],
        outputs: [output(OWN_SCRIPT, 500_000, 'qbrt1zown')],
        fee: -490_000,
        feeRate: -126.94,
        statedRecipients: [],
      })
    )
    expect(spendSummary.netSpend).toBe(-490_000)
    expect(spendSummary.feeAssessment).toBeUndefined()
    expect(risks).toEqual([])
  })

  it('leaves the net spend and fee unknown while an input lacks its spent output', () => {
    const { spendSummary, risks } = summarizeQbitPsbtSpend(
      params({
        inputs: [input(OWN_SCRIPT, 1_000_000), input(undefined, 0)],
        isCompleted: false,
        fee: 0,
        feeRate: 0,
      })
    )
    expect(spendSummary.netSpend).toBeUndefined()
    expect(spendSummary.feeAssessment).toBeUndefined()
    expect(spendSummary.walletInputValue).toBe(1_000_000)
    expect(risks).toEqual([])
  })

  it('gates an abnormal fee and records when no live rate was compared', () => {
    const highFee = summarizeQbitPsbtSpend(
      params({
        outputs: [
          output(MERCHANT_SCRIPT, 10_000, 'qbrt1zmerchant'),
          output(OWN_SCRIPT, 446_000, 'qbrt1zown'),
        ],
        fee: 544_000,
        feeRate: 140.9,
      })
    )
    expect(highFee.spendSummary.netSpend).toBe(554_000)
    expect(highFee.spendSummary.feeAssessment?.reasons).toEqual([
      'above_recommended_rate',
      'above_relay_floor',
      'large_share_of_amount',
    ])
    expect(highFee.risks.map(risk => [risk.type, risk.level])).toEqual([
      [RiskType.HIGH_FEE_RATE, 'warning'],
    ])

    const noQuote = summarizeQbitPsbtSpend(params({ feeSummary: undefined }))
    expect(noQuote.recommendedFeeRate).toBeUndefined()
    expect(noQuote.spendSummary.feeAssessment).toEqual({
      fee: 3_860,
      feeRate: 1,
      amount: 10_000,
      reasons: [],
    })
  })

  it('refuses amounts that are not safe integers', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 2, -1, 0.5]) {
      expect(() =>
        summarizeQbitPsbtSpend(params({ inputs: [input(STRANGER_SCRIPT, value)] }))
      ).toThrow(RangeError)
      expect(() =>
        summarizeQbitPsbtSpend(
          params({ outputs: [output(MERCHANT_SCRIPT, value, 'qbrt1zmerchant')] })
        )
      ).toThrow(RangeError)
    }
    expect(() =>
      summarizeQbitPsbtSpend(
        params({
          inputs: [
            input(OWN_SCRIPT, Number.MAX_SAFE_INTEGER, 'qbrt1zown'),
            input(OWN_SCRIPT, 1, 'qbrt1zown'),
          ],
        })
      )
    ).toThrow(RangeError)
  })

  it('refuses stated recipients that are not a list of addresses', () => {
    for (const statedRecipients of ['qbrt1zmerchant', [42], [null], {}]) {
      expect(() =>
        summarizeQbitPsbtSpend(params({ statedRecipients: statedRecipients as never }))
      ).toThrow(TypeError)
    }
    expect(
      summarizeQbitPsbtSpend(params({ statedRecipients: [''] })).spendSummary.outputRoles
    ).toEqual(['unrecognised', 'wallet'])
  })
})
