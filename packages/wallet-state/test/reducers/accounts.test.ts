import { describe, it, expect } from 'vitest'
import accountsReducer, { accountActions, initialState } from '../../src/reducers/accounts'

describe('accounts reducer', () => {
  describe('initial state', () => {
    it('should return initial state when passed undefined', () => {
      const result = accountsReducer(undefined, { type: 'unknown' })
      expect(result).toEqual(initialState)
    })

    it('should have correct initial values', () => {
      expect(initialState.accounts).toEqual([])
      expect(initialState.loading).toBe(false)
      expect(initialState.balanceV2Map).toEqual({})
      expect(initialState.current.address).toBe('')
    })
  })

  describe('setCurrent', () => {
    it('should set current account', () => {
      const account = {
        type: 'hd',
        address: 'qb1ztest123',
        brandName: 'Qbit',
        alianName: 'Account 1',
        displayBrandName: 'Qbit',
        index: 0,
        balance: 0,
        pubkey: '02abc123',
        key: 'key1',
        flag: 0,
      }

      const state = accountsReducer(initialState, accountActions.setCurrent(account))
      expect(state.current).toEqual(account)
    })

    it('should reset to initial account when payload is falsy', () => {
      const state = accountsReducer(initialState, accountActions.setCurrent(null as any))
      expect(state.current.address).toBe('')
      expect(state.current.type).toBe('')
    })
  })

  describe('setAccounts', () => {
    it('should set accounts array', () => {
      const accounts = [
        {
          type: 'hd',
          address: 'qb1ztest1',
          brandName: 'Qbit',
          alianName: 'Account 1',
          displayBrandName: 'Qbit',
          index: 0,
          balance: 100000,
          pubkey: '02abc1',
          key: 'key1',
          flag: 0,
        },
        {
          type: 'hd',
          address: 'qb1ztest2',
          brandName: 'Qbit',
          alianName: 'Account 2',
          displayBrandName: 'Qbit',
          index: 1,
          balance: 200000,
          pubkey: '02abc2',
          key: 'key2',
          flag: 0,
        },
      ]

      const state = accountsReducer(initialState, accountActions.setAccounts(accounts))
      expect(state.accounts).toHaveLength(2)
      expect(state.accounts[0].address).toBe('qb1ztest1')
      expect(state.accounts[1].address).toBe('qb1ztest2')
    })
  })

  describe('setBalanceV2', () => {
    it('should set balance v2 for an address', () => {
      const payload = {
        address: 'qb1ztest123',
        balance: {
          availableBalance: 95000,
          unavailableBalance: 5000,
          totalBalance: 100000,
          chainType: 'QBIT_MAINNET',
        },
      }

      const state = accountsReducer(initialState, accountActions.setBalanceV2(payload))

      expect(state.balanceV2Map['qb1ztest123']).toBeDefined()
      expect(state.balanceV2Map['qb1ztest123'].availableBalance).toBe(95000)
      expect(state.balanceV2Map['qb1ztest123'].unavailableBalance).toBe(5000)
      expect(state.balanceV2Map['qb1ztest123'].totalBalance).toBe(100000)
    })

    it('should preserve optional qbit balance detail fields', () => {
      const payload = {
        address: 'qbit-test-address',
        balance: {
          availableBalance: 0,
          unavailableBalance: 35000,
          totalBalance: 35000,
          immatureBalance: 25000,
          pendingBalance: 10000,
          chainType: 'QBIT_MAINNET',
        },
      }

      const state = accountsReducer(initialState, accountActions.setBalanceV2(payload))

      expect(state.balanceV2Map['qbit-test-address']).toMatchObject({
        immatureBalance: 25000,
        pendingBalance: 10000,
      })
    })
  })

  describe('balance refresh status', () => {
    const address = 'qb1ztest123'
    const balance = (totalBalance: number) => ({
      availableBalance: totalBalance,
      unavailableBalance: 0,
      totalBalance,
      chainType: 'QBIT_MAINNET',
    })

    it('records a failure without inventing a balance', () => {
      const state = accountsReducer(
        initialState,
        accountActions.setBalanceError({ address, requestId: 1 })
      )

      expect(state.balanceStatusMap[address]).toEqual({ requestId: 1, error: true })
      expect(state.balanceV2Map[address]).toBeUndefined()
    })

    it('keeps the last known balance on failure and clears the error on success', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 1 })
      )
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 2 }))

      expect(state.balanceStatusMap[address].error).toBe(true)
      expect(state.balanceV2Map[address].totalBalance).toBe(5000)

      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(7000), requestId: 3 })
      )
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: false,
        balanceRequestId: 3,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(7000)
    })

    it('ignores a failure from a request older than the applied success', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 2 })
      )
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 1 }))

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 2,
        error: false,
        balanceRequestId: 2,
      })
    })

    it('stores a success that arrives after a newer failure, and keeps the failure', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 1 })
      )
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 3 }))
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(9000), requestId: 2 })
      )

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 2,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(9000)
    })

    it('stores a first balance that arrives after a newer failure', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceError({ address, requestId: 2 })
      )
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 1 })
      )

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 2,
        error: true,
        balanceRequestId: 1,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(5000)
    })

    it('clears the failure once a refresh newer than it succeeds, after a late balance', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceError({ address, requestId: 2 })
      )
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 1 })
      )
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(7000), requestId: 3 })
      )

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: false,
        balanceRequestId: 3,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(7000)
    })

    it('ignores a success older than the stored balance, after a failure too', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({ address, balance: balance(5000), requestId: 2 })
      )
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 3 }))
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance(9000), requestId: 1 })
      )

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 2,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(5000)
    })
  })

  describe('setHistory', () => {
    it('should set transaction history for an address', () => {
      const payload = {
        address: 'qb1ztest123',
        total: 42,
        firstPageTxids: ['tx1', 'tx2'],
        verifiedPendingTxids: ['tx3'],
        list: [
          { txid: 'tx1', time: 1234567890 },
          { txid: 'tx2', time: 1234567891 },
        ] as any[],
      }

      const state = accountsReducer(initialState, accountActions.setHistory(payload))

      expect(state.historyMap['qb1ztest123']).toBeDefined()
      expect(state.historyMap['qb1ztest123'].list).toHaveLength(2)
      expect(state.historyMap['qb1ztest123'].total).toBe(42)
      expect(state.historyMap['qb1ztest123'].firstPageTxids).toEqual(['tx1', 'tx2'])
      expect(state.historyMap['qb1ztest123'].verifiedPendingTxids).toEqual(['tx3'])
      expect(state.historyMap['qb1ztest123'].expired).toBe(false)
    })

    it('preserves a known total when an omitted-total caller omits it', () => {
      let state = accountsReducer(
        initialState,
        accountActions.setHistory({
          address: 'qb1ztest123',
          list: [],
          total: 42,
          firstPageTxids: ['tx1'],
          verifiedPendingTxids: ['tx2'],
        })
      )
      state = accountsReducer(
        state,
        accountActions.setHistory({ address: 'qb1ztest123', list: [] })
      )

      expect(state.historyMap['qb1ztest123'].total).toBe(42)
      expect(state.historyMap['qb1ztest123'].firstPageTxids).toBeUndefined()
      expect(state.historyMap['qb1ztest123'].verifiedPendingTxids).toBeUndefined()
    })

    it('stores the dispatched list as-is (lifecycle merging happens in the fetch callback)', () => {
      const pendingTx = { txid: 'tx-pending', confirmations: 0 } as any
      const confirmedTx = { txid: 'tx-confirmed', confirmations: 2 } as any

      let state = accountsReducer(
        initialState,
        accountActions.setHistory({ address: 'qb1ztest123', list: [pendingTx, confirmedTx] })
      )
      state = accountsReducer(
        state,
        accountActions.setHistory({
          address: 'qb1ztest123',
          list: [{ ...confirmedTx, confirmations: 3 }, { ...pendingTx, replaced: true }],
        })
      )

      expect(state.historyMap['qb1ztest123'].list).toHaveLength(2)
      expect(state.historyMap['qb1ztest123'].list[1]).toMatchObject({
        txid: 'tx-pending',
        replaced: true,
      })
    })

    it('should take fresh confirmations when a reorged tx returns as pending', () => {
      const confirmedTx = { txid: 'tx1', confirmations: 1 } as any

      let state = accountsReducer(
        initialState,
        accountActions.setHistory({ address: 'qb1ztest123', list: [confirmedTx] })
      )
      state = accountsReducer(
        state,
        accountActions.setHistory({
          address: 'qb1ztest123',
          list: [{ ...confirmedTx, confirmations: 0 }],
        })
      )

      expect(state.historyMap['qb1ztest123'].list).toHaveLength(1)
      expect(state.historyMap['qb1ztest123'].list[0]).toMatchObject({
        txid: 'tx1',
        confirmations: 0,
      })
      expect(state.historyMap['qb1ztest123'].list[0].replaced).toBeUndefined()
    })
  })

  describe('expireHistory', () => {
    it('expires history by its explicit Qbit scope key', () => {
      const scopeKey = `qbit:QBIT_TESTNET4:${'11'.repeat(32)}`
      let state = accountsReducer(
        initialState,
        accountActions.setCurrent({
          type: 'QBIT_HD',
          address: 'tq1qrotatingreceiveaddress',
        } as any)
      )
      state = accountsReducer(
        state,
        accountActions.setHistory({
          address: scopeKey,
          list: [{ txid: 'tx1' }] as any[],
        })
      )

      state = accountsReducer(state, accountActions.expireHistory(scopeKey))

      expect(state.historyMap[scopeKey].expired).toBe(true)
      expect(state.historyMap[state.current.address]).toBeUndefined()
    })

    it('keeps the current-address fallback for existing callers', () => {
      const address = 'bc1qtest123'
      let state = accountsReducer(
        initialState,
        accountActions.setCurrent({
          type: 'hd',
          address,
        } as any)
      )
      state = accountsReducer(
        state,
        accountActions.setHistory({
          address,
          list: [{ txid: 'tx1' }] as any[],
        })
      )

      state = accountsReducer(state, accountActions.expireHistory())

      expect(state.historyMap[address].expired).toBe(true)
    })
  })

  describe('setCurrentAccountName', () => {
    it('should update current account name and matching account in list', () => {
      const account = {
        type: 'hd',
        address: 'qb1ztest123',
        brandName: 'Qbit',
        alianName: 'Account 1',
        displayBrandName: 'Qbit',
        index: 0,
        balance: 0,
        pubkey: '02abc123',
        key: 'key1',
        flag: 0,
      }

      let state = accountsReducer(initialState, accountActions.setCurrent(account))
      state = accountsReducer(state, accountActions.setAccounts([account]))
      state = accountsReducer(state, accountActions.setCurrentAccountName('New Name'))

      expect(state.current.alianName).toBe('New Name')
      expect(state.accounts[0].alianName).toBe('New Name')
    })
  })

  describe('pendingLogin / rejectLogin', () => {
    it('should set loading to true on pendingLogin', () => {
      const state = accountsReducer(initialState, accountActions.pendingLogin(undefined))
      expect(state.loading).toBe(true)
    })

    it('should set loading to false on rejectLogin', () => {
      let state = accountsReducer(initialState, accountActions.pendingLogin(undefined))
      expect(state.loading).toBe(true)

      state = accountsReducer(state, accountActions.rejectLogin(undefined))
      expect(state.loading).toBe(false)
    })
  })

  describe('reset', () => {
    it('should reset state to initial state', () => {
      let state = accountsReducer(initialState, accountActions.pendingLogin(undefined))
      state = accountsReducer(
        state,
        accountActions.setCurrent({
          type: 'hd',
          address: 'qb1ztest123',
          brandName: 'Qbit',
          alianName: 'Account 1',
          displayBrandName: 'Qbit',
          index: 0,
          balance: 100000,
          pubkey: '02abc123',
          key: 'key1',
          flag: 0,
        })
      )

      expect(state.loading).toBe(true)
      expect(state.current.address).toBe('qb1ztest123')

      state = accountsReducer(state, accountActions.reset(undefined))
      expect(state).toEqual(initialState)
    })
  })
})
