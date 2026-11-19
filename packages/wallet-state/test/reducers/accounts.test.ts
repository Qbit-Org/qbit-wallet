import { describe, it, expect } from 'vitest'
import accountsReducer, {
  accountActions,
  initialState,
  type AccountsState,
} from '../../src/reducers/accounts'

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

    it('stores an incomplete outputs read, and clears it with the next balance that is not', () => {
      const address = 'qbit-many-outputs'
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({
          address,
          balance: {
            availableBalance: null,
            unavailableBalance: 91_000_000,
            totalBalance: 91_000_000,
            immatureBalance: null,
            pendingBalance: null,
            utxoReadIncomplete: true,
            chainType: 'QBIT_MAINNET',
          },
          requestId: 1,
        })
      )

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: null,
        unavailableBalance: 91_000_000,
        totalBalance: 91_000_000,
        utxoReadIncomplete: true,
      })

      // As the next read arrives over the UI port: JSON leaves out an unset flag.
      const fullRead = JSON.parse(
        JSON.stringify({
          availableBalance: 60_000_000,
          unavailableBalance: 31_000_000,
          totalBalance: 91_000_000,
          immatureBalance: 0,
          pendingBalance: 31_000_000,
          utxoReadIncomplete: undefined,
          chainType: 'QBIT_MAINNET',
        })
      )
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: fullRead, requestId: 2 })
      )

      expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
      expect(state.balanceV2Map[address].availableBalance).toBe(60_000_000)
      expect(state.balanceV2Map[address].unavailableBalance).toBe(31_000_000)
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
      // An older read that could not finish the outputs: its flag stays out too.
      state = accountsReducer(
        state,
        accountActions.setBalanceV2({
          address,
          balance: {
            ...balance(9000),
            availableBalance: null,
            unavailableBalance: 9000,
            utxoReadIncomplete: true,
          },
          requestId: 1,
        })
      )

      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 2,
      })
      expect(state.balanceV2Map[address].totalBalance).toBe(5000)
      expect(state.balanceV2Map[address].availableBalance).toBe(5000)
      expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
    })
  })

  describe('an answer that could not read every output', () => {
    const address = 'qb1ztest123'
    /** The answers other screens read, and their outcome, are those of `before`, as they were. */
    const expectSameAnswers = (after: AccountsState, before: AccountsState): void => {
      expect(after.balanceV2Map).toBe(before.balanceV2Map)
      expect(after.balanceStatusMap).toBe(before.balanceStatusMap)
    }
    const fullRead = {
      availableBalance: 60_000_000,
      unavailableBalance: 31_000_000,
      totalBalance: 91_000_000,
      immatureBalance: 0,
      pendingBalance: 31_000_000,
      chainType: 'QBIT_MAINNET',
    }
    // Read later, with a total that moved since: over a known split none of
    // it may be kept.
    const incompleteRead = {
      availableBalance: null,
      unavailableBalance: 92_000_000,
      totalBalance: 92_000_000,
      immatureBalance: null,
      pendingBalance: null,
      utxoReadIncomplete: true,
      chainType: 'QBIT_MAINNET',
    }
    const failedRead = { ...incompleteRead, utxoReadFailed: true }
    const laterFull = {
      ...fullRead,
      availableBalance: 62_000_000,
      unavailableBalance: 30_000_000,
      totalBalance: 92_000_000,
    }
    const set = (
      state: typeof initialState,
      balance: Record<string, unknown>,
      requestId?: number
    ) =>
      accountsReducer(
        state,
        accountActions.setBalanceV2({ address, balance: balance as any, requestId })
      )

    it.each([
      ['ran out of time part of the way through', incompleteRead],
      ['failed', failedRead],
    ])(
      'keeps a known split, marked out of date, when a later read of the outputs %s, and a full answer then replaces it and clears the error',
      (_how, answer) => {
        let state = set(initialState, fullRead, 1)
        const known = state.balanceV2Map[address]
        state = set(state, answer, 2)

        // Recorded as a refresh that failed: nothing of the answer is kept.
        expect(state.balanceV2Map[address]).toEqual(known)
        expect(state.balanceStatusMap[address]).toEqual({
          requestId: 2,
          error: true,
          balanceRequestId: 1,
        })

        state = set(state, laterFull, 3)
        expect(state.balanceV2Map[address]).toMatchObject({
          availableBalance: 62_000_000,
          unavailableBalance: 30_000_000,
          totalBalance: 92_000_000,
        })
        expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
        expect(state.balanceStatusMap[address]).toEqual({
          requestId: 3,
          error: false,
          balanceRequestId: 3,
        })
      }
    )

    it.each([
      [
        'a measured 0 available',
        { ...fullRead, availableBalance: 0, unavailableBalance: 91_000_000 },
      ],
      [
        "a split read from the address's history past the explorer's limit",
        { ...fullRead, utxoLimitExceeded: true },
      ],
    ])('counts %s as a known split', (_case, stored) => {
      let state = set(initialState, stored, 1)
      state = set(state, failedRead, 2)

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: stored.availableBalance,
        totalBalance: 91_000_000,
      })
      expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 2,
        error: true,
        balanceRequestId: 1,
      })
    })

    it.each<[string, Record<string, unknown> | undefined]>([
      ['nothing is stored yet', undefined],
      [
        "only a total is stored, past the explorer's limit",
        { ...incompleteRead, utxoReadIncomplete: undefined, utxoLimitExceeded: true },
      ],
      [
        'only a total is stored, from a read that stopped waiting for the send guard',
        { ...incompleteRead, utxoReadIncomplete: undefined },
      ],
      ['the stored answer could not read every output either', incompleteRead],
      [
        'the stored answer could not read every output, though it carries figures',
        { ...fullRead, utxoReadIncomplete: true },
      ],
    ])('stores the total with the split unknown when %s', (_case, stored) => {
      let state = stored ? set(initialState, stored, 1) : initialState
      state = set(
        state,
        { ...failedRead, totalBalance: 93_000_000, unavailableBalance: 93_000_000 },
        2
      )

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: null,
        unavailableBalance: 93_000_000,
        totalBalance: 93_000_000,
        utxoReadIncomplete: true,
      })
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 2,
        error: false,
        balanceRequestId: 2,
      })
    })

    it("does not count another network's split", () => {
      let state = set(initialState, { ...fullRead, chainType: 'QBIT_TESTNET4' }, 1)
      state = set(state, failedRead, 2)

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: null,
        totalBalance: 92_000_000,
        utxoReadIncomplete: true,
        chainType: 'QBIT_MAINNET',
      })
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 2,
        error: false,
        balanceRequestId: 2,
      })
    })

    it("does not count another account's split", () => {
      const other = 'qbit-other-account'
      let state = accountsReducer(
        initialState,
        accountActions.setBalanceV2({ address: other, balance: fullRead as any, requestId: 1 })
      )
      state = set(state, failedRead, 2)

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: null,
        totalBalance: 92_000_000,
        utxoReadIncomplete: true,
      })
      expect(state.balanceStatusMap[address].error).toBe(false)
      expect(state.balanceV2Map[other]).toMatchObject({ availableBalance: 60_000_000 })
      expect(state.balanceStatusMap[other]).toEqual({
        requestId: 1,
        error: false,
        balanceRequestId: 1,
      })
    })

    it('changes nothing when such an answer arrives after a newer full one', () => {
      let state = set(initialState, fullRead, 1)
      // Refreshes 2 and 3 are out, and 3 answers first, in full.
      state = set(state, laterFull, 3)
      const settled = state
      state = set(state, failedRead, 2)

      expect(state).toBe(settled)
    })

    it('stores an older full answer that arrives after a newer one could not read every output, and keeps the failure', () => {
      let state = set(initialState, fullRead, 1)
      // Refreshes 2 and 3 are out, and 3 answers first, without every output.
      state = set(state, failedRead, 3)
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 1,
      })

      // As after any newer failure: the newest balance read is stored, and
      // stays marked out of date.
      state = set(state, laterFull, 2)
      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: 62_000_000,
        totalBalance: 92_000_000,
      })
      expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 2,
      })
    })

    it.each([
      ['ran out of time part of the way through', incompleteRead],
      ['failed', failedRead],
    ])(
      'puts the split of an older read in the place of a newer answer whose read of the outputs %s, with no split shown before, and keeps that answer as a failed refresh',
      (_how, answer) => {
        // A cold account: the account updater's read (1) is still out when
        // the card's poll read (2) answers without every output.
        let state = set(initialState, answer, 2)
        expect(state.balanceV2Map[address]).toMatchObject({
          availableBalance: null,
          totalBalance: 92_000_000,
          utxoReadIncomplete: true,
        })
        expect(state.balanceStatusMap[address]).toEqual({
          requestId: 2,
          error: false,
          balanceRequestId: 2,
        })

        // Read 1 then answers in full: its split is the newest split read,
        // and read 2 stays the outcome, now as a refresh that failed.
        state = set(state, fullRead, 1)
        expect(state.balanceV2Map[address]).toEqual(
          set(initialState, fullRead, 1).balanceV2Map[address]
        )
        expect(state.balanceStatusMap[address]).toEqual({
          requestId: 2,
          error: true,
          balanceRequestId: 1,
        })
        // Just as had the two arrived in order.
        expect(state).toEqual(set(set(initialState, fullRead, 1), answer, 2))

        // A newer full answer clears the failure.
        state = set(state, laterFull, 3)
        expect(state.balanceV2Map[address]).toMatchObject({
          availableBalance: 62_000_000,
          totalBalance: 92_000_000,
        })
        expect(state.balanceStatusMap[address]).toEqual({
          requestId: 3,
          error: false,
          balanceRequestId: 3,
        })
      }
    )

    it('keeps a newer failure as the outcome when an older split replaces the answer that could not read every output', () => {
      let state = set(initialState, incompleteRead, 2)
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 3 }))
      state = set(state, fullRead, 1)

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: 60_000_000,
        totalBalance: 91_000_000,
      })
      expect(state.balanceV2Map[address].utxoReadIncomplete).toBeUndefined()
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 1,
      })
    })

    it.each<[string, Record<string, unknown>]>([
      [
        'could not read every output either',
        { ...failedRead, totalBalance: 91_500_000, unavailableBalance: 91_500_000 },
      ],
      [
        'carries figures, but could not read every output',
        { ...fullRead, utxoReadIncomplete: true },
      ],
      [
        "is a total alone, past the explorer's limit",
        { ...incompleteRead, utxoReadIncomplete: undefined, utxoLimitExceeded: true },
      ],
      [
        'is a total alone, from a read that stopped waiting for the send guard',
        { ...incompleteRead, utxoReadIncomplete: undefined },
      ],
      ["is another network's split", { ...fullRead, chainType: 'QBIT_TESTNET4' }],
    ])(
      'leaves a newer answer that could not read every output in place of an older answer that %s',
      (_case, older) => {
        const state = set(initialState, failedRead, 2)

        // The answers and their outcome stay as they were; the card's own
        // record may note the older answer (`balanceReadMap`).
        expectSameAnswers(set(state, older, 1), state)
      }
    )

    it.each<[string, Record<string, unknown>]>([
      ['a full answer', laterFull],
      [
        "a total alone, past the explorer's limit",
        { ...incompleteRead, utxoReadIncomplete: undefined, utxoLimitExceeded: true },
      ],
      [
        'a total alone, from a read that stopped waiting for the send guard',
        { ...incompleteRead, utxoReadIncomplete: undefined },
      ],
    ])(
      'does not put the split of an older read in the place of %s that is newer',
      (_case, newer) => {
        let state = set(initialState, newer, 2)
        expectSameAnswers(set(state, fullRead, 1), state)

        // Nor after a newer refresh failed.
        state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 3 }))
        expectSameAnswers(set(state, fullRead, 1), state)
      }
    )

    it('orders it against rejected refreshes as one of them', () => {
      let state = set(initialState, fullRead, 1)
      state = set(state, incompleteRead, 3)
      // An older rejection changes nothing; a newer one is the outcome.
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 2 }))
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 3,
        error: true,
        balanceRequestId: 1,
      })
      state = accountsReducer(state, accountActions.setBalanceError({ address, requestId: 4 }))
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 4,
        error: true,
        balanceRequestId: 1,
      })
      // And an older such answer after a newer rejection changes nothing.
      const settled = state
      expect(set(state, incompleteRead, 3)).toBe(settled)
      expect(state.balanceV2Map[address]).toMatchObject({ availableBalance: 60_000_000 })
    })

    it("records such an answer without a request id in the latest refresh's place", () => {
      let state = set(initialState, fullRead, 5)
      state = set(state, incompleteRead)

      expect(state.balanceV2Map[address]).toMatchObject({
        availableBalance: 60_000_000,
        totalBalance: 91_000_000,
      })
      expect(state.balanceStatusMap[address]).toEqual({
        requestId: 5,
        error: true,
        balanceRequestId: 5,
      })
    })
  })

  describe('every order of full, incomplete and rejected answers', () => {
    // Two or three refreshes of one account answer in every order: in full,
    // without every output (ran out of time part of the way through, or
    // failed), or rejected. Before them, nothing is shown, or a split is
    // shown, or another network's split is stored. Each order is checked
    // against this reference, stated over the answers alone:
    //
    // - Wherever 1.0.9 showed a split, the same split and the same warning.
    //   1.0.9 counted an answer that could not read every output as a
    //   rejected refresh: it showed the newest full answer, where that is
    //   for this network, marked out of date ("could not be refreshed")
    //   where a newer read did not answer in full.
    // - Where no full answer for this network has arrived at all, the total
    //   of the newest answer that could not read every output, with `--`
    //   and the note, marked out of date where a newer read was rejected.
    // - Otherwise, as in 1.0.9: `--`, with the load error where the newest
    //   read did not answer in full.
    //
    // And whatever the order, the store ends as it would have had the
    // answers arrived in request order.
    const address = 'qbit-ordered-account'
    const network = 'QBIT_MAINNET'
    type Kind = 'full' | 'incomplete' | 'failed' | 'rejected'
    interface Answer {
      requestId: number
      kind: Kind
      chainType: string
    }
    type State = typeof initialState

    // Figures that tell the answers apart by their request id.
    const figuresOf = ({ requestId, kind, chainType }: Answer) =>
      kind === 'full'
        ? {
            availableBalance: requestId * 1_000,
            unavailableBalance: 500,
            totalBalance: requestId * 1_000 + 500,
            immatureBalance: 0,
            pendingBalance: 500,
            chainType,
          }
        : {
            availableBalance: null,
            unavailableBalance: requestId * 1_000 + 700,
            totalBalance: requestId * 1_000 + 700,
            immatureBalance: null,
            pendingBalance: null,
            utxoReadIncomplete: true,
            ...(kind === 'failed' ? { utxoReadFailed: true } : {}),
            chainType,
          }
    const arrive = (state: State, answer: Answer): State =>
      answer.kind === 'rejected'
        ? accountsReducer(
            state,
            accountActions.setBalanceError({ address, requestId: answer.requestId })
          )
        : accountsReducer(
            state,
            accountActions.setBalanceV2({
              address,
              balance: figuresOf(answer) as any,
              requestId: answer.requestId,
            })
          )

    // What the card shows on `network`, as useBalanceCardLogic reads the store.
    const cardOf = (state: State) => {
      const stored = state.balanceV2Map[address]
      const loaded = stored?.chainType === network
      const failed = state.balanceStatusMap[address]?.error === true
      return {
        total: loaded ? stored.totalBalance : '--',
        available: loaded && stored.utxoReadIncomplete !== true ? stored.availableBalance : '--',
        note: loaded && stored.utxoReadIncomplete === true,
        warning: !failed ? 'none' : loaded ? 'could not be refreshed' : 'could not be loaded',
      }
    }

    const newest = (answers: Answer[]): Answer | undefined =>
      answers.reduce<Answer | undefined>(
        (found, answer) => (!found || answer.requestId > found.requestId ? answer : found),
        undefined
      )
    const isIncomplete = (answer: Answer) =>
      answer.kind === 'incomplete' || answer.kind === 'failed'

    // The reference above.
    const expectedCard = (answers: Answer[]) => {
      const last = newest(answers)!
      const shownIn109 = newest(answers.filter(answer => answer.kind === 'full'))
      if (shownIn109?.chainType === network) {
        const figures = figuresOf(shownIn109)
        return {
          total: figures.totalBalance,
          available: figures.availableBalance,
          note: false,
          warning: last.kind === 'full' ? 'none' : 'could not be refreshed',
        }
      }
      const fullForNetwork = answers.some(
        answer => answer.kind === 'full' && answer.chainType === network
      )
      const standIn = newest(
        answers.filter(answer => isIncomplete(answer) && answer.chainType === network)
      )
      if (!fullForNetwork && standIn) {
        return {
          total: figuresOf(standIn).totalBalance,
          available: '--',
          note: true,
          warning: last.kind === 'rejected' ? 'could not be refreshed' : 'none',
        }
      }
      return {
        total: '--',
        available: '--',
        note: false,
        warning: last.kind === 'full' ? 'none' : 'could not be loaded',
      }
    }

    const permutations = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [
              item,
              ...rest,
            ])
          )
    const kindSequences = (count: number): Kind[][] =>
      count === 0
        ? [[]]
        : kindSequences(count - 1).flatMap(rest =>
            (['full', 'incomplete', 'failed', 'rejected'] as Kind[]).map(kind => [...rest, kind])
          )
    const before: Array<[string, Answer[]]> = [
      ['nothing shown before', []],
      ['a split shown before', [{ requestId: 1, kind: 'full', chainType: network }]],
      [
        "another network's split stored before",
        [{ requestId: 1, kind: 'full', chainType: 'QBIT_TESTNET4' }],
      ],
    ]

    it('matches the reference in every order, and ends as it would in request order', () => {
      const tally = { orders: 0, split: 0, totalAndNote: 0, nothing: 0 }
      const unlikeReference: string[] = []
      const unlikeRequestOrder: string[] = []
      for (const [shownBefore, prefix] of before) {
        for (const count of [2, 3]) {
          for (const kinds of kindSequences(count)) {
            const answers = kinds.map((kind, index) => ({
              requestId: index + 2,
              kind,
              chainType: network,
            }))
            const expected = expectedCard([...prefix, ...answers])
            const inRequestOrder = [...prefix, ...answers].reduce(arrive, initialState)
            for (const order of permutations(answers)) {
              tally.orders += 1
              if (expected.note) tally.totalAndNote += 1
              else if (typeof expected.available === 'number') tally.split += 1
              else tally.nothing += 1
              const state = [...prefix, ...order].reduce(arrive, initialState)
              const label = `${shownBefore}, then ${order
                .map(answer => `${answer.kind} ${answer.requestId}`)
                .join(', ')}`
              const card = cardOf(state)
              if (JSON.stringify(card) !== JSON.stringify(expected)) {
                unlikeReference.push(
                  `${label}: ${JSON.stringify(card)}, not ${JSON.stringify(expected)}`
                )
              }
              const stored = {
                balance: state.balanceV2Map[address],
                status: state.balanceStatusMap[address],
              }
              const storedInOrder = {
                balance: inRequestOrder.balanceV2Map[address],
                status: inRequestOrder.balanceStatusMap[address],
              }
              try {
                expect(stored).toEqual(storedInOrder)
              } catch {
                unlikeRequestOrder.push(
                  `${label}: ${JSON.stringify(stored)}, not ${JSON.stringify(storedInOrder)}`
                )
              }
            }
          }
        }
      }

      expect(unlikeReference).toEqual([])
      expect(unlikeRequestOrder).toEqual([])
      // Three starts; 16 pairs of answers in 2 orders and 64 triples in 6.
      // The total and the note only where no full answer arrived (two starts,
      // 8 pairs and 26 triples), and `--` only where every refresh was
      // rejected.
      expect(tally).toEqual({ orders: 1_248, split: 888, totalAndNote: 344, nothing: 16 })
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
      const scopeKey = `qbit-account:QBIT_TESTNET4:${'11'.repeat(32)}`
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
