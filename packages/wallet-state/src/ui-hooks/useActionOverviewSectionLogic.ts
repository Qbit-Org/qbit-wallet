import { numUtils } from '@qbit/base-utils'
import { DecodedPsbt, PsbtActionInfo, PsbtActionType } from '@qbit/wallet-shared'
import { useMemo } from 'react'
import { useI18n } from 'src/context'
import { useChain, useQbitUnit } from 'src/hooks'
import { qbitFeeWarningText } from 'src/utils/qbit-fee-warning-text'

export interface ActionOverviewSectionProps {
  action: PsbtActionInfo
  decodedPsbt: DecodedPsbt
}

/** What the reviewed PSBT does to the wallet, as the approval shows it first. */
export interface ActionOverviewSpend {
  /** What leaves the wallet, fee included; negative when it gains. Absent when unknown. */
  netSpend?: number
  /**
   * "X to others + Y network fee", present only when the net spend is exactly
   * that: every input is the wallet's own.
   */
  breakdown?: string
  feeWarningTitle?: string
  feeWarnings: string[]
  /** Present when an output pays an address that is neither the wallet's nor the named recipient. */
  unrecognisedOutputs?: string
}

export function useActionOverviewSectionLogic({ action, decodedPsbt }: ActionOverviewSectionProps) {
  const { t } = useI18n()

  const chain = useChain()

  const qbitUnit = useQbitUnit()

  // Computed by the background from the exact PSBT bytes under review; see
  // PsbtSpendSummary. Nothing is shown when a summary is absent.
  const spend = useMemo((): ActionOverviewSpend | undefined => {
    const summary = decodedPsbt?.spendSummary
    if (!summary) return undefined
    const feeWarning = qbitFeeWarningText(summary.feeAssessment, t, qbitUnit)
    const fee = summary.feeAssessment?.fee
    const decomposes =
      summary.netSpend !== undefined &&
      fee !== undefined &&
      summary.netSpend === summary.externalOutputValue + fee
    return {
      ...(summary.netSpend !== undefined ? { netSpend: summary.netSpend } : {}),
      ...(decomposes
        ? {
            breakdown: t('net_spend_breakdown', [
              numUtils.satoshisToAmount(summary.externalOutputValue),
              qbitUnit,
              numUtils.satoshisToAmount(fee),
              qbitUnit,
            ]),
          }
        : {}),
      ...(feeWarning.title !== undefined ? { feeWarningTitle: feeWarning.title } : {}),
      feeWarnings: feeWarning.lines,
      ...(summary.unrecognisedOutputCount > 0
        ? {
            unrecognisedOutputs: t('unrecognised_outputs_summary', [
              String(summary.unrecognisedOutputCount),
              numUtils.satoshisToAmount(summary.unrecognisedOutputValue),
              qbitUnit,
            ]),
          }
        : {}),
    }
  }, [decodedPsbt, t, qbitUnit])

  if (!action) {
    action = {
      name: '',
      description: '',
      type: PsbtActionType.DEFAULT,
    }
  }

  if (action.details?.length === 0) {
    action.details = []
  }

  if (action.type === PsbtActionType.DEFAULT) {
    action.name = t('sign_transaction')
    action.description = ''
    action.details = []
  }

  return {
    decodedPsbt,
    action,
    spend,
    chain,
  }
}
