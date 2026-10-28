import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { PsbtActionType, type DecodedPsbt, type PsbtSpendSummary } from '@qbit/wallet-shared'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nContext } from '../../src/context/I18nContext'
import { useActionOverviewSectionLogic } from '../../src/ui-hooks/useActionOverviewSectionLogic'
import { createHookTestHarness } from './testHelpers'

const SUMMARY: PsbtSpendSummary = {
  account: 'qb1ztestaccount',
  walletInputValue: 1_000_000,
  walletOutputValue: 986_140,
  netSpend: 13_860,
  externalOutputValue: 10_000,
  outputRoles: ['recipient', 'wallet'],
  unrecognisedOutputCount: 0,
  unrecognisedOutputValue: 0,
  undecodableOutputCount: 0,
  feeAssessment: { fee: 3_860, feeRate: 1, amount: 10_000, recommendedFeeRate: 1, reasons: [] },
}

function decoded(spendSummary: PsbtSpendSummary): DecodedPsbt {
  return {
    inputInfos: [],
    outputInfos: [],
    feeRate: spendSummary.feeAssessment?.feeRate ?? 0,
    fee: spendSummary.feeAssessment?.fee ?? 0,
    features: { rbf: false },
    risks: [],
    isScammer: false,
    recommendedFeeRate: 1,
    shouldWarnFeeRate: false,
    isCompleted: spendSummary.feeAssessment !== undefined,
    spendSummary,
  }
}

function renderOverview(spendSummary: PsbtSpendSummary) {
  const { wrapper: baseWrapper } = createHookTestHarness()
  const t = (key: string, substitutions?: string | string[] | Record<string, string | number>) =>
    Array.isArray(substitutions) ? `${key}:${substitutions.join(',')}` : key
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      I18nContext.Provider,
      {
        value: {
          t,
          locale: 'en',
          supportedLocales: [],
          localeNames: {},
          changeLocale: async () => {},
          isSpecialLocale: false,
        },
      },
      createElement(baseWrapper, { children })
    )
  return renderHook(
    () =>
      useActionOverviewSectionLogic({
        action: { name: '', description: '', type: PsbtActionType.DEFAULT },
        decodedPsbt: decoded(spendSummary),
      }),
    { wrapper }
  ).result.current
}

describe('useActionOverviewSectionLogic spend summary (#271)', () => {
  afterEach(() => cleanup())

  it('leads with the amount leaving the wallet and splits it into payments and fee', () => {
    const { spend } = renderOverview(SUMMARY)
    expect(spend).toEqual({
      netSpend: 13_860,
      breakdown: 'net_spend_breakdown:0.00010000,QBT,0.00003860,QBT',
      feeWarnings: [],
    })
  })

  it('does not split the net spend when another party funds part of the transaction', () => {
    const { spend } = renderOverview({
      ...SUMMARY,
      walletInputValue: 500_000,
      walletOutputValue: 490_000,
      netSpend: 10_000,
    })
    expect(spend?.netSpend).toBe(10_000)
    expect(spend?.breakdown).toBeUndefined()
  })

  it('explains an abnormal fee and the outputs the wallet does not recognise', () => {
    const { spend } = renderOverview({
      ...SUMMARY,
      netSpend: 1_644_000,
      externalOutputValue: 100_000,
      outputRoles: ['unrecognised', 'wallet'],
      unrecognisedOutputCount: 1,
      unrecognisedOutputValue: 100_000,
      feeAssessment: {
        fee: 1_544_000,
        feeRate: 400,
        amount: 100_000,
        recommendedFeeRate: 2,
        reasons: ['above_recommended_rate', 'above_relay_floor', 'large_share_of_amount'],
      },
    })
    expect(spend).toEqual({
      netSpend: 1_644_000,
      breakdown: 'net_spend_breakdown:0.00100000,QBT,0.01544000,QBT',
      feeWarningTitle: 'the_fee_rate_is_much_higher_than_recommended_fee_rate',
      feeWarnings: [
        'fee_warning_above_recommended:400,200,2',
        'fee_warning_above_relay_floor:400,400,1',
        'fee_warning_amount_share:1544,0.00100000,QBT',
      ],
      unrecognisedOutputs: 'unrecognised_outputs_summary:1,0.00100000,QBT',
    })
  })

  it('does not claim a comparison with recommended rates that were unavailable', () => {
    const { spend } = renderOverview({
      ...SUMMARY,
      feeAssessment: {
        fee: 386_000,
        feeRate: 100,
        amount: 10_000_000,
        reasons: ['above_relay_floor'],
      },
    })
    expect(spend?.feeWarningTitle).toBe('high_fee_rate_risk_title')
    expect(spend?.feeWarnings).toEqual(['fee_warning_above_relay_floor:100,100,1'])
  })

  it('leaves the net spend unknown when an input does not say what it spends', () => {
    const { netSpend: _netSpend, feeAssessment: _feeAssessment, ...incomplete } = SUMMARY
    const { spend } = renderOverview(incomplete)
    expect(spend).toEqual({ feeWarnings: [] })
  })
})
