import {
  DecodedPsbt,
  PsbtActionDetailType,
  PsbtActionInfo,
  PsbtActionType,
} from '@qbit/wallet-shared'
import { useMemo } from 'react'
import { useI18n } from 'src/context'
import { useChain, useCurrentAddress } from 'src/hooks'

export interface ActionOverviewSectionProps {
  action: PsbtActionInfo
  decodedPsbt: DecodedPsbt
}

export function useActionOverviewSectionLogic({ action, decodedPsbt }: ActionOverviewSectionProps) {
  const { t } = useI18n()

  const chain = useChain()

  const currentAddress = useCurrentAddress()

  const spendSatoshis = useMemo(() => {
    const inValue = decodedPsbt.inputInfos
      .filter(v => v.address === currentAddress)
      .reduce((pre, cur) => cur.value + pre, 0)
    const outValue = decodedPsbt.outputInfos
      .filter(v => v.address === currentAddress)
      .reduce((pre, cur) => cur.value + pre, 0)
    const spend = inValue - outValue
    return spend
  }, [decodedPsbt, currentAddress])

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

  const commonDetails: any[] = []
  if (spendSatoshis < 0) {
    commonDetails.push({
      type: PsbtActionDetailType.SATOSHIS,
      label: t('receive'),
      value: `${-spendSatoshis}`,
    })
  }

  return {
    decodedPsbt,
    action,
    commonDetails,
    chain,
  }
}
