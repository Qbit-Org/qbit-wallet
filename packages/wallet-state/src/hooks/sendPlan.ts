import { useCallback, useEffect, useRef, useState } from 'react'

import { BUS_METHODS, type QbitSendPlanView } from '@qbit/wallet-shared'

import { useWallet } from '../context/WalletContext'
import { uiEventBus } from '../utils/eventBus'
import { readQbitSendPlanView } from '../utils/qbit-send-plan'
import { useAccountAddress } from './accounts'
import { useChainType } from './settings'

/** How often a page reads an open plan again besides the change events, as a backstop. */
export const QBIT_SEND_PLAN_POLL_MS = 5_000

export interface QbitSendPlanState {
  /**
   * The selected account's plan on the active network: undefined until a
   * read for that account and network lands, null when it has none.
   */
  plan: QbitSendPlanView | null | undefined
  /** The last read failed; `plan` is the last one known, if any. */
  readFailed: boolean
  /** Read the plan again. */
  refresh: () => void
  /**
   * Run a wallet call that answers with the plan as it left it (`viewOf`
   * picks the plan out of the answer), and show that plan unless something
   * newer is shown by then. The call's own answer is returned, and its
   * failure rethrown.
   */
  apply: <T>(call: () => Promise<T>, viewOf: (result: T) => unknown) => Promise<T>
}

interface Gate {
  /** The account and network shown, as `${chain}:${address}`. */
  scope: string
  /** Numbers each read and call in the order it started. */
  sequence: number
  /** The latest sequence whose answer is shown. */
  published: number
  /** The plan shown, as of the latest answer published. */
  shown: QbitSendPlanView | null | undefined
}

/**
 * The selected account's open send plan (#188), read on mount, on every
 * `QBIT_SEND_PLAN_CHANGED`, on `ACCOUNTS_CHANGED` and `CHAIN_CHANGED`, and
 * every `QBIT_SEND_PLAN_POLL_MS` while a plan is open and not completed or
 * the last read failed. A plan is never shown for another account or
 * network than the selected ones: an answer is dropped when the account or
 * network changed since its read started, or when it names another.
 *
 * Answers can land out of order. Of one plan, a view with a lower revision
 * than the one shown is stale and dropped. Otherwise an answer is dropped
 * when a read or call that started later has already been shown, so an
 * earlier read can never bring back a plan a later one found gone. One read
 * runs at a time; reads asked for meanwhile become one more read after it.
 */
export function useQbitSendPlan(): QbitSendPlanState {
  const wallet = useWallet()
  const address = useAccountAddress()
  const chainType = useChainType()
  const scope = `${chainType}:${address}`

  const [state, setState] = useState<{
    scope: string
    plan: QbitSendPlanView | null | undefined
    readFailed: boolean
  }>({ scope, plan: undefined, readFailed: false })

  const gateRef = useRef<Gate>({ scope, sequence: 0, published: 0, shown: undefined })
  const mountedRef = useRef(true)
  // The scope of the read running, if one is, and whether another was asked for meanwhile.
  const readingRef = useRef<string | null>(null)
  const readAgainRef = useRef(false)

  const publish = useCallback((answer: unknown, sequence: number, answerScope: string): void => {
    const gate = gateRef.current
    if (!mountedRef.current || answerScope !== gate.scope) return
    const view = readQbitSendPlanView(answer)
    if (view === undefined) {
      // Not a plan: count it as a failed read, which the poll retries.
      if (sequence >= gate.published) {
        setState(current =>
          current.scope === answerScope ? { ...current, readFailed: true } : current
        )
      }
      return
    }
    if (view && `${view.chain}:${view.address}` !== answerScope) return
    const shown = gate.shown
    if (view && shown && shown.id === view.id) {
      if (view.revision < shown.revision) return
      if (view.revision === shown.revision && sequence < gate.published) return
    } else if (sequence < gate.published) {
      return
    }
    gate.published = Math.max(gate.published, sequence)
    gate.shown = view
    setState({ scope: answerScope, plan: view, readFailed: false })
  }, [])

  const read = useCallback((): void => {
    const readScope = gateRef.current.scope
    if (readingRef.current === readScope) {
      readAgainRef.current = true
      return
    }
    readingRef.current = readScope
    readAgainRef.current = false
    const sequence = ++gateRef.current.sequence
    wallet
      .getQbitSendPlan()
      .then(
        answer => publish(answer, sequence, readScope),
        () => {
          const gate = gateRef.current
          if (!mountedRef.current || readScope !== gate.scope || sequence < gate.published) return
          setState(current =>
            current.scope === readScope ? { ...current, readFailed: true } : current
          )
        }
      )
      .finally(() => {
        if (readingRef.current !== readScope) return
        readingRef.current = null
        if (readAgainRef.current && mountedRef.current && gateRef.current.scope === readScope) {
          read()
        }
      })
  }, [wallet, publish])

  // A new account or network starts from nothing known: every answer for
  // the earlier one is dropped, including those still on their way.
  useEffect(() => {
    mountedRef.current = true
    const gate = gateRef.current
    gate.scope = scope
    gate.published = gate.sequence
    gate.shown = undefined
    readAgainRef.current = false
    setState({ scope, plan: undefined, readFailed: false })
    read()
  }, [scope, read])

  useEffect(() => {
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const onPlanChanged = (params?: { planId?: unknown; revision?: unknown }): void => {
      const shown = gateRef.current.shown
      // A change this page already shows needs no read.
      if (
        shown &&
        params?.planId === shown.id &&
        typeof params.revision === 'number' &&
        params.revision <= shown.revision
      ) {
        return
      }
      read()
    }
    const onAccountOrChain = (): void => read()
    uiEventBus.addEventListener(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, onPlanChanged)
    uiEventBus.addEventListener(BUS_METHODS.ACCOUNTS_CHANGED, onAccountOrChain)
    uiEventBus.addEventListener(BUS_METHODS.CHAIN_CHANGED, onAccountOrChain)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, onPlanChanged)
      uiEventBus.removeEventListener(BUS_METHODS.ACCOUNTS_CHANGED, onAccountOrChain)
      uiEventBus.removeEventListener(BUS_METHODS.CHAIN_CHANGED, onAccountOrChain)
    }
  }, [read])

  const current = state.scope === scope
  const plan = current ? state.plan : undefined
  const readFailed = current && state.readFailed
  // A completed plan, or none, has nothing left to follow.
  const polling = readFailed || (plan !== undefined && plan !== null && plan.phase !== 'completed')

  useEffect(() => {
    if (!polling) return undefined
    const timer = setInterval(read, QBIT_SEND_PLAN_POLL_MS)
    return () => clearInterval(timer)
  }, [polling, read])

  const apply = useCallback(
    async <T>(call: () => Promise<T>, viewOf: (result: T) => unknown): Promise<T> => {
      const gate = gateRef.current
      const sequence = ++gate.sequence
      const callScope = gate.scope
      const result = await call()
      publish(viewOf(result), sequence, callScope)
      return result
    },
    [publish]
  )

  return { plan, readFailed, refresh: read, apply }
}
