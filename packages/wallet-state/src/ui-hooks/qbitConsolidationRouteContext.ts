import type { ToSignData } from '@qbit/wallet-shared'
import type { RouteParamList } from 'src/context/NavigationContext'

/**
 * What the success screen takes to offer the next batch after a
 * consolidation batch: the flag, and the batch's size, which the next batch
 * is offered at. The confirm screen hands it to the success screen, or to
 * the recovery screen, which hands it on to the success screen a retry or a
 * status check ends on.
 */
export type QbitConsolidationRouteContext = Pick<
  RouteParamList['TxSuccessScreen'],
  'consolidation' | 'consolidationMaxInputs'
>

/**
 * The consolidation context `state` carries: the flag when it is `true`,
 * with the batch's size when that is a safe integer (the consolidation
 * screen checks it against the account's maximum). Route state can come
 * from an earlier version, so anything else reads as no consolidation, or
 * as a batch that recorded no size, whose next batch opens at the maximum.
 * The confirm, failure and success screens all read the context this way.
 */
export function qbitConsolidationRouteContext(
  state: { consolidation?: unknown; consolidationMaxInputs?: unknown } | undefined
): QbitConsolidationRouteContext {
  if (state?.consolidation !== true) return {}
  const maxInputs = state.consolidationMaxInputs
  return typeof maxInputs === 'number' && Number.isSafeInteger(maxInputs)
    ? { consolidation: true, consolidationMaxInputs: maxInputs }
    : { consolidation: true }
}

/** The consolidation context of `toSignData`: none unless it is a consolidation batch. */
export function txConsolidationRouteContext(toSignData: ToSignData): QbitConsolidationRouteContext {
  const consolidation = toSignData.qbitConsolidation
  if (!consolidation) return {}
  return qbitConsolidationRouteContext({
    consolidation: true,
    consolidationMaxInputs: consolidation.maxInputs,
  })
}
