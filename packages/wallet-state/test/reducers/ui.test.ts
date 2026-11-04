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
  // As an earlier build saved it: no addressInput, amountInput or
  // navigationSource, a fee bar with only some fields, and a field that no
  // build reads any more.
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

  it('lets updateAddressInput and updateAmountInput write after the update', () => {
    const loaded = uiReducer(savedBefore(), updateVersion())

    const withAddress = uiReducer(loaded, uiActions.updateAddressInput({ address: 'tq1typed' }))
    const withAmount = uiReducer(withAddress, uiActions.updateAmountInput({ amount: '1.25' }))

    expect(withAmount.addressInput).toEqual({ address: 'tq1typed' })
    expect(withAmount.amountInput).toEqual({ amount: '1.25' })
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
      addressInput: null,
      amountInput: 'old',
    } as unknown as typeof initialState

    const state = uiReducer(saved, updateVersion())

    expect(state.addressInput).toEqual(initialState.addressInput)
    expect(state.amountInput).toEqual(initialState.amountInput)
  })

  it('starts from the initial state when the saved state is not an object', () => {
    expect(uiReducer(null as unknown as typeof initialState, updateVersion())).toEqual(initialState)
  })

  it('leaves a complete saved state as it was', () => {
    const saved = {
      ...initialState,
      addressInput: { address: 'tq1saved' },
      feeRateBar: {
        ...initialState.feeRateBar,
        feeRateSource: { quoteRead: 'page:1', optionIndex: 2 },
      },
    }

    expect(uiReducer(saved, updateVersion())).toEqual(saved)
  })
})
