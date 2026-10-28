import { describe, expect, it } from 'vitest'

import { updateVersion } from '../../src/actions/global'
import settingsReducer, { initialState } from '../../src/reducers/settings'
import { ChainType, NetworkType } from '@qbit/wallet-types'

describe('settings reducer', () => {
  it('defaults to Qbit Mainnet', () => {
    expect(settingsReducer(undefined, { type: 'unknown' })).toMatchObject({
      chainType: ChainType.QBIT_MAINNET,
      networkType: NetworkType.MAINNET,
    })
  })

  it('keeps Mainnet as the network fallback during version updates', () => {
    const state = settingsReducer(initialState, updateVersion())

    expect(state.networkType).toBe(NetworkType.MAINNET)
  })
})
