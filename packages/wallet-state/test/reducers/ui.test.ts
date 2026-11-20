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

describe('ui reducer on a ui state saved by an earlier build', () => {
  // As an earlier build saved it: a fee bar with only some fields, and a
  // field that no build reads any more.
  const savedBefore = () =>
    ({
      uiTxCreateScreen: {
        toInfo: { address: 'tq1saved', domain: 'saved.example' },
        inputAmount: '0.5',
        enableRBF: false,
        memo: 'kept',
      },
      feeRateBar: { feeRate: 7, feeRateInputVal: '7' },
      isBalanceHidden: true,
    }) as unknown as typeof initialState

  it('lets updateTxCreateScreen and updateFeeRateBar write after the update', () => {
    const { uiTxCreateScreen: _, feeRateBar: __, ...withoutForm } = savedBefore()
    const loaded = uiReducer(withoutForm as typeof initialState, updateVersion())

    const withForm = uiReducer(loaded, uiActions.updateTxCreateScreen({ inputAmount: '1.25' }))
    const withFee = uiReducer(withForm, uiActions.updateFeeRateBar({ feeRate: 9 }))

    expect(withFee.uiTxCreateScreen).toEqual({
      ...initialState.uiTxCreateScreen,
      inputAmount: '1.25',
    })
    expect(withFee.feeRateBar).toEqual({ ...initialState.feeRateBar, feeRate: 9 })
  })

  it('fills every missing field, at every depth, and keeps what was saved', () => {
    const state = uiReducer(savedBefore(), updateVersion())

    expect(state).toEqual({
      ...initialState,
      uiTxCreateScreen: {
        toInfo: { address: 'tq1saved', domain: 'saved.example' },
        inputAmount: '0.5',
        enableRBF: false,
        memo: 'kept',
      },
      feeRateBar: { ...initialState.feeRateBar, feeRate: 7, feeRateInputVal: '7' },
      isBalanceHidden: true,
    })
  })

  it('replaces a saved field that should hold an object but does not', () => {
    const saved = {
      ...initialState,
      uiTxCreateScreen: null,
      feeRateBar: 'old',
    } as unknown as typeof initialState

    const state = uiReducer(saved, updateVersion())

    expect(state.uiTxCreateScreen).toEqual(initialState.uiTxCreateScreen)
    expect(state.feeRateBar).toEqual(initialState.feeRateBar)
  })

  it('starts from the initial state when the saved state is not an object', () => {
    expect(uiReducer(null as unknown as typeof initialState, updateVersion())).toEqual(initialState)
  })

  it('leaves a complete saved state as it was', () => {
    const saved = {
      ...initialState,
      uiTxCreateScreen: { ...initialState.uiTxCreateScreen, inputAmount: '0.5' },
      feeRateBar: {
        ...initialState.feeRateBar,
        feeRateSource: { quoteRead: 'page:1', optionIndex: 2 },
      },
    }

    expect(uiReducer(saved, updateVersion())).toEqual(saved)
  })
})
