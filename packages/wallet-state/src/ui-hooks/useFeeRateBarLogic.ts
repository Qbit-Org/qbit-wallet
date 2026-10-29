import { useCallback, useEffect, useMemo, useState } from 'react'
import { QBIT_MAX_FEE_RATE, QBIT_MIN_RELAY_FEE_RATE, type FeeSummary } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { useI18n, useWallet } from '../context'
import { useChain, useFeeRateBar, useUpdateFeeRateBar } from '../hooks'

enum FeeRateType {
  SLOW,
  AVG,
  FAST,
  CUSTOM,
}

interface FeeOption {
  type?: FeeRateType
  title: string
  desc?: string
  feeRate: number
  targetBlocks?: number
}

/**
 * A fee quote a screen reads once and shares with its fee bar, so that the
 * rates the bar offers and the rate the screen checks come from one quote.
 * A read that failed is loaded with no summary.
 */
export type FeeQuoteState = { status: 'loading' } | { status: 'loaded'; summary?: FeeSummary }

const translationKeys = {
  [FeeRateType.SLOW]: { type: FeeRateType.SLOW, title: 'slow', desc: 'feerate_slow_desc' },
  [FeeRateType.AVG]: { type: FeeRateType.AVG, title: 'avg', desc: 'feerate_avg_desc' },
  [FeeRateType.FAST]: { type: FeeRateType.FAST, title: 'fast', desc: 'feerate_fast_desc' },
} as const

const DEFAULT_FEE_RATE = 1
const AVG_OPTION_INDEX = 1

// Fee rate display rules:
// if (Fast = Avg = Slow) -> show Fast time (30s) for all
// if (Fast = Avg) -> show Fast time (30s) for both
// if (Avg = Slow) -> show Avg time (1.5m) for both

function formatFeeRateTextKey(
  list: FeeOption[],
  supportLowFeeMode: boolean,
  t: (key: string, substitutions?: string | string[] | Record<string, string | number>) => string
): FeeOption[] {
  const { FAST, AVG, SLOW } = FeeRateType
  const fastRate = list[FAST]?.feeRate ?? 0
  const avgRate = list[AVG]?.feeRate ?? 0
  const slowRate = list[SLOW]?.feeRate ?? 0

  return list.map((option, index) => {
    const keys = translationKeys[index as FeeRateType]
    if (!keys) return option

    let title = t(keys.title)
    let desc =
      option.targetBlocks === undefined
        ? t(keys.desc)
        : t('qbit_feerate_target_desc', [String(option.targetBlocks), String(option.targetBlocks)])

    if (option.targetBlocks === undefined && fastRate === slowRate) {
      desc = t('feerate_fast_desc')
    }

    if (supportLowFeeMode) {
      if (index === SLOW) {
        title = t('feerate_sub1_title')
        desc = ''
      }
    }

    return {
      ...option,
      title,
      desc,
    }
  })
}

// The quote's list with low-fee mode's slow rate, below 1 sat/vB, in place of
// its own. A new list: the quote's may be one its screen checks fees with.
function withLowFeeSlowRate(list: FeeOption[], lowFeeSummary: FeeSummary): FeeOption[] {
  let slow: FeeOption = lowFeeSummary.list[1]

  // try use slow fee rate if it's lower than 1 sat/vB
  if (slow.feeRate > 1) {
    slow = lowFeeSummary.list[0]
  }

  // ensure slow fee rate is below 1 sat/vB
  if (slow.feeRate > 1) {
    slow = { ...slow, feeRate: 0.1 }
  }

  return [slow, ...list.slice(1)]
}

export function useFeeRateBarLogic({
  readonly,
  quote,
}: {
  readonly?: boolean
  /** The quote its screen read; without one the fee bar reads its own. */
  quote?: FeeQuoteState
}) {
  const wallet = useWallet()
  const [ownSummary, setOwnSummary] = useState<FeeSummary | undefined>()
  // Low-fee rates with the summary they were read for, so that rates read for
  // an earlier quote never join a newer one.
  const [lowFeeRead, setLowFeeRead] = useState<
    { summary: FeeSummary; lowFeeSummary: FeeSummary } | undefined
  >()
  const feeRateBarState = useFeeRateBar()
  const updateFeeRateBar = useUpdateFeeRateBar()
  const feeRateInputVal = feeRateBarState.feeRateInputVal
  const feeOptionIndex = feeRateBarState.feeOptionIndex
  const showCustomInput = feeRateBarState.showCustomInput
  const feeRate = feeRateBarState.feeRate
  const { t, isSpecialLocale } = useI18n()
  const chain = useChain()
  const isQbitChain =
    chain.enum === ChainType.QBIT_MAINNET ||
    chain.enum === ChainType.QBIT_TESTNET4 ||
    chain.enum === ChainType.QBIT_REGTEST
  const fontSize = useMemo(() => (isSpecialLocale ? 'xxxs' : 'xxs'), [isSpecialLocale])

  const configuredLowFeeMode = chain.enableLowFeeMode ?? false
  const sharesQuote = quote !== undefined

  useEffect(() => {
    if (sharesQuote) return undefined
    let cancelled = false

    const loadFeeSummary = async () => {
      const feeSummary = await wallet.getFeeSummary()
      if (cancelled) return
      setOwnSummary(feeSummary)
    }

    void loadFeeSummary()

    return () => {
      cancelled = true
    }
  }, [wallet, sharesQuote, chain.enum])

  const feeSummary = quote ? (quote.status === 'loaded' ? quote.summary : undefined) : ownSummary
  const feeQuote = feeSummary?.quote
  const lowFeeModeApplies =
    configuredLowFeeMode && feeSummary !== undefined && feeQuote === undefined

  useEffect(() => {
    if (!feeSummary || !lowFeeModeApplies) return undefined
    let cancelled = false

    const loadLowFeeSummary = async () => {
      const lowFeeSummary = await wallet.getLowFeeSummary()
      if (cancelled) return
      setLowFeeRead({ summary: feeSummary, lowFeeSummary })
    }

    void loadLowFeeSummary()

    return () => {
      cancelled = true
    }
  }, [wallet, feeSummary, lowFeeModeApplies])

  // Derived during render, so the options move to a newer quote in the same
  // render as the fee check of the screen that shares it.
  const feeOptions = useMemo((): FeeOption[] => {
    if (!feeSummary) return []

    let list: FeeOption[] = feeSummary.list
    if (lowFeeModeApplies) {
      if (lowFeeRead?.summary !== feeSummary) return []
      list = withLowFeeSlowRate(list, lowFeeRead.lowFeeSummary)
    }

    const translatedList = formatFeeRateTextKey(list, lowFeeModeApplies, t)
    return readonly
      ? translatedList
      : [...translatedList, { type: FeeRateType.CUSTOM, title: t('custom'), feeRate: 0 }]
  }, [feeSummary, lowFeeModeApplies, lowFeeRead, t, readonly])

  const supportLowFeeMode = configuredLowFeeMode && feeQuote === undefined

  // Memoize default value to avoid repeated calculations
  const defaultFeeRate = useMemo(
    () => feeOptions[AVG_OPTION_INDEX]?.feeRate ?? DEFAULT_FEE_RATE,
    [feeOptions]
  )

  useEffect(() => {
    let val = defaultFeeRate
    if (feeOptionIndex === FeeRateType.CUSTOM) {
      val = parseFloat(feeRateInputVal) || 0
    } else if (feeOptions.length > 0) {
      val = feeOptions[feeOptionIndex]?.feeRate ?? defaultFeeRate
    }

    if (val.toString() == feeRate.toString()) {
      return
    }

    if (val === feeRate) {
      return
    }

    updateFeeRateBar({ feeRate: val })
  }, [feeOptions, feeOptionIndex, feeRateInputVal, defaultFeeRate, feeRate])

  const adjustFeeRateInput = useCallback(
    (inputVal: string) => {
      // When user manually changes the input, check if we need to switch to CUSTOM
      const shouldSwitchToCustom = feeOptionIndex !== FeeRateType.CUSTOM && feeOptions.length > 0
      const selectedOption = feeOptions[feeOptionIndex]

      // If currently on SLOW/AVG/FAST and user changes the value, switch to CUSTOM
      if (shouldSwitchToCustom && selectedOption) {
        const currentValue = selectedOption.feeRate.toString()
        const parsedInput = Number(inputVal)
        const isSelectedRecommendation =
          inputVal === currentValue ||
          (inputVal.trim() !== '' &&
            !inputVal.endsWith('.') &&
            Number.isFinite(parsedInput) &&
            parsedInput === selectedOption.feeRate)
        if (isSelectedRecommendation) {
          return
        }
      }

      const updateInputValue = (value: string) =>
        updateFeeRateBar({
          feeRateInputVal: value,
          feeOptionIndex:
            shouldSwitchToCustom && selectedOption ? FeeRateType.CUSTOM : undefined,
        })

      // Allow empty input
      if (inputVal === '') {
        updateInputValue('')
        return
      }

      const val = parseFloat(inputVal)

      // Check if input is a valid number
      if (isNaN(val)) {
        updateInputValue('')
        return
      }

      // Allow intermediate input like "0" or "0." for typing "0.1"
      if (inputVal === '0' || inputVal.endsWith('.')) {
        updateInputValue(inputVal)
        return
      }

      // Validate and constrain the value
      if (val <= 0) {
        updateInputValue(defaultFeeRate.toString())
      } else if (val > QBIT_MAX_FEE_RATE) {
        updateInputValue(isQbitChain ? inputVal : QBIT_MAX_FEE_RATE.toString())
      } else if (val < 1 && supportLowFeeMode == false) {
        updateInputValue('1')
      } else if (val < 0.1) {
        updateInputValue('0.1')
      } else {
        updateInputValue(inputVal)
      }
    },
    [defaultFeeRate, updateFeeRateBar, feeOptionIndex, feeOptions, supportLowFeeMode, isQbitChain]
  )

  const isCustomOption = useCallback((option: FeeOption) => option.type === FeeRateType.CUSTOM, [t])

  const setFeeOptionIndex = useCallback(
    (index: number) => {
      const selectedOption = feeOptions[index]
      if (index !== FeeRateType.CUSTOM && selectedOption) {
        // When clicking on SLOW/AVG/FAST, show input and fill with the corresponding value
        updateFeeRateBar({
          feeOptionIndex: index,
          showCustomInput: true,
          feeRateInputVal: selectedOption.feeRate.toString(),
        })
      } else if (index === FeeRateType.CUSTOM) {
        // When clicking on CUSTOM, show input with current custom value or empty
        updateFeeRateBar({
          feeOptionIndex: index,
          showCustomInput: true,
        })
      }
    },
    [feeOptions, updateFeeRateBar]
  )

  const toggleCustomInput = useCallback(
    (show: boolean) => {
      updateFeeRateBar({ showCustomInput: show })
    },
    [updateFeeRateBar]
  )

  return {
    feeOptions,
    feeOptionIndex,
    setFeeOptionIndex,
    feeRateInputVal,
    adjustFeeRateInput,
    isCustomOption,
    fontSize,
    isSpecialLocale,
    showCustomInput: readonly ? false : showCustomInput,
    toggleCustomInput,
    supportLowFeeMode,
    feeQuote,
    feeEstimateUnavailable: feeQuote?.availability === 'unavailable',
    fallbackFeeRate: QBIT_MIN_RELAY_FEE_RATE,
  }
}
