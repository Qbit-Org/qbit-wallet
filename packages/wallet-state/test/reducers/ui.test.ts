import { describe, expect, it } from 'vitest'

import { updateVersion } from '../../src/actions/global'
import uiReducer, { initialState, uiActions } from '../../src/reducers/ui'

describe('ui reducer fee rate source', () => {
  const source = { quoteRead: 'page:1', optionIndex: 2 }

  it('records the source written with a rate', () => {
    const state = uiReducer(
      initialState,
      uiActions.updateFeeRateBar({ feeRate: 3, feeRateSource: source })
    )

    expect(state.feeRateBar).toMatchObject({ feeRate: 3, feeRateSource: source })
  })

  it('clears the source when a rate is written without one', () => {
    const recorded = uiReducer(
      initialState,
      uiActions.updateFeeRateBar({ feeRate: 3, feeRateSource: source })
    )

    const state = uiReducer(recorded, uiActions.updateFeeRateBar({ feeRate: 40 }))

    expect(state.feeRateBar).toMatchObject({ feeRate: 40, feeRateSource: null })
  })

  it('keeps the source when other fields change', () => {
    const recorded = uiReducer(
      initialState,
      uiActions.updateFeeRateBar({ feeRate: 3, feeRateSource: source })
    )

    const state = uiReducer(recorded, uiActions.updateFeeRateBar({ showCustomInput: true }))

    expect(state.feeRateBar.feeRateSource).toEqual(source)
  })

  it('reads a fee bar stored without a source as having none', () => {
    const { feeRateSource: _, ...storedBefore } = { ...initialState.feeRateBar, feeRate: 5 }
    const stored = { ...initialState, feeRateBar: storedBefore } as typeof initialState

    const state = uiReducer(stored, updateVersion())

    expect(state.feeRateBar).toEqual({ ...storedBefore, feeRateSource: null })
  })
})
