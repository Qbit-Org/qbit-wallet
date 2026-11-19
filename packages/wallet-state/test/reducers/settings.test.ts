import { describe, expect, it } from 'vitest'

import settingsReducer from '../../src/reducers/settings'
import { ChainType } from '@qbit/wallet-types'

describe('settings reducer', () => {
  it('defaults to Qbit Mainnet', () => {
    expect(settingsReducer(undefined, { type: 'unknown' })).toMatchObject({
      chainType: ChainType.QBIT_MAINNET,
    })
  })
})
