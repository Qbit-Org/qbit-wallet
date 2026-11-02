import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  type FeeQuoteMetadata,
  type FeeSummary,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { useI18n, useWallet } from '../context'
import { useChain, useFeeRateBar, useUpdateFeeRateBar } from '../hooks'
import type { FeeRateSource, UIState } from '../reducers/ui'

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
 * An option the bar offers, with the option index it selects: a tier's
 * position, or CUSTOM for the Custom option wherever it stands.
 */
type FeeBarOption = FeeOption & { index: number }

/**
 * A fee quote a screen reads once and shares with its fee bar, so that the
 * rates the bar offers and the rate the screen checks come from one quote.
 * A read that failed is loaded with no summary. `read` names the read, and
 * the fee bar records it with each rate it chooses from the quote.
 */
export type FeeQuoteState =
  | { status: 'loading' }
  | { status: 'loaded'; read: string; summary?: FeeSummary }

const QUOTE_LOADING: FeeQuoteState = { status: 'loading' }

// The fee-bar store, with the source of its rate, is saved and outlives the
// page that wrote it, so a read's name is unique to this page as well.
const FEE_QUOTE_READS_PAGE = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`
let feeQuoteReads = 0

/**
 * Reads the selected network's fee quote, again when the network changes,
 * and names each read. Loading until the read for the selected network
 * lands, also in the render in which the network changes. Reads nothing
 * while `enabled` is false.
 */
export function useFeeQuoteRead(enabled = true): FeeQuoteState {
  const wallet = useWallet()
  const chainType = useChain()?.enum
  const [landed, setLanded] = useState<{ chainType?: ChainType; quote: FeeQuoteState }>()

  useEffect(() => {
    if (!enabled) return undefined
    const read = `${FEE_QUOTE_READS_PAGE}:${++feeQuoteReads}`
    let cancelled = false
    setLanded(undefined)
    wallet
      .getFeeSummary()
      .then(summary => {
        if (!cancelled) setLanded({ chainType, quote: { status: 'loaded', read, summary } })
      })
      .catch(e => {
        console.log(e)
        if (!cancelled) setLanded({ chainType, quote: { status: 'loaded', read } })
      })
    return () => {
      cancelled = true
    }
  }, [wallet, chainType, enabled])

  return landed !== undefined && landed.chainType === chainType ? landed.quote : QUOTE_LOADING
}

/**
 * Where the fee bar's selected rate stands with `quote`: `custom`, the
 * user's own; `quote`, a tier's rate the bar chose from that quote; or
 * `pending`, a tier's rate not yet chosen from it, which is the bar's
 * default or a rate from an earlier read, possibly another network's.
 */
export function feeRateOrigin(
  feeRateBar: Pick<UIState['feeRateBar'], 'feeOptionIndex' | 'feeRateSource'>,
  quote: FeeQuoteState
): 'custom' | 'quote' | 'pending' {
  if (feeRateBar.feeOptionIndex === FeeRateType.CUSTOM) return 'custom'
  const source = feeRateBar.feeRateSource
  return quote.status === 'loaded' &&
    source?.quoteRead === quote.read &&
    source.optionIndex === feeRateBar.feeOptionIndex
    ? 'quote'
    : 'pending'
}

/**
 * Whether the selected rate is settled for a screen that reads `quote` and
 * last ran its checks at `checkedFeeRate`: a Custom rate always; a tier's
 * once the fee bar chose it from `quote` and the screen's checks ran at it.
 */
export function useFeeRateSettled(
  quote: FeeQuoteState,
  checkedFeeRate: number | undefined
): boolean {
  const feeRateBar = useFeeRateBar()
  const origin = feeRateOrigin(feeRateBar, quote)
  return origin === 'custom' || (origin === 'quote' && checkedFeeRate === feeRateBar.feeRate)
}

function sameFeeRateSource(a: FeeRateSource | null | undefined, b: FeeRateSource | null): boolean {
  return a?.quoteRead === b?.quoteRead && a?.optionIndex === b?.optionIndex
}

/** What the fee bar shows for one read of the quote. */
interface FeeBarQuote {
  /** The read the options come from; none before a read lands. */
  read?: string
  options: FeeBarOption[]
  quote?: FeeQuoteMetadata
  /** The read failed: no rates to offer but Custom, and the bar says it uses the relay floor. */
  readFailed: boolean
  /** Low-fee mode's slow rate, below 1 sat/vB, is among the options. */
  lowFeeMode: boolean
}

const NO_QUOTE_YET: FeeBarQuote = { options: [], readFailed: false, lowFeeMode: false }

function optionAt(options: FeeBarOption[], index: number): FeeBarOption | undefined {
  return options.find(option => option.index === index)
}

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
  let slow: FeeOption | undefined = lowFeeSummary.list[1]

  // try use slow fee rate if it's lower than 1 sat/vB
  if (!slow || slow.feeRate > 1) {
    slow = lowFeeSummary.list[0] ?? slow
  }
  if (!slow) return list

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
  // Low-fee rates with the summary they were read for, so that rates read for
  // an earlier quote never join a newer one. No rates: that read failed.
  const [lowFeeRead, setLowFeeRead] = useState<
    { summary: FeeSummary; lowFeeSummary?: FeeSummary } | undefined
  >()
  const feeRateBarState = useFeeRateBar()
  const updateFeeRateBar = useUpdateFeeRateBar()
  const feeRateInputVal = feeRateBarState.feeRateInputVal
  const feeOptionIndex = feeRateBarState.feeOptionIndex
  const showCustomInput = feeRateBarState.showCustomInput
  const feeRate = feeRateBarState.feeRate
  const feeRateSource = feeRateBarState.feeRateSource
  const { t, isSpecialLocale } = useI18n()
  const chain = useChain()
  const isQbitChain =
    chain.enum === ChainType.QBIT_MAINNET ||
    chain.enum === ChainType.QBIT_TESTNET4 ||
    chain.enum === ChainType.QBIT_REGTEST
  const fontSize = useMemo(() => (isSpecialLocale ? 'xxxs' : 'xxs'), [isSpecialLocale])

  const configuredLowFeeMode = chain.enableLowFeeMode ?? false
  const ownRead = useFeeQuoteRead(quote === undefined)

  const read = quote ?? ownRead
  const readName = read.status === 'loaded' ? read.read : undefined
  const feeSummary = read.status === 'loaded' ? read.summary : undefined
  const lowFeeModeApplies =
    configuredLowFeeMode && feeSummary !== undefined && feeSummary.quote === undefined

  useEffect(() => {
    if (!feeSummary || !lowFeeModeApplies) return undefined
    let cancelled = false
    wallet
      .getLowFeeSummary()
      .then(lowFeeSummary => {
        if (!cancelled) setLowFeeRead({ summary: feeSummary, lowFeeSummary })
      })
      .catch(e => {
        console.log(e)
        // The quote's own rates stand in for low-fee mode's.
        if (!cancelled) setLowFeeRead({ summary: feeSummary })
      })
    return () => {
      cancelled = true
    }
  }, [wallet, feeSummary, lowFeeModeApplies])

  // What the bar shows for the current read, derived during render so that it
  // moves to a newer quote in the same render as the fee check of the screen
  // that shares it. Undefined while the read, or its low-fee read, is pending.
  const readQuote = useMemo((): FeeBarQuote | undefined => {
    if (readName === undefined) return undefined
    const custom: FeeBarOption = {
      type: FeeRateType.CUSTOM,
      index: FeeRateType.CUSTOM,
      title: t('custom'),
      feeRate: 0,
    }
    if (!feeSummary) {
      return {
        read: readName,
        options: readonly ? [] : [custom],
        readFailed: true,
        lowFeeMode: false,
      }
    }

    // Tiers take the indices below Custom's; a summary may list more.
    let list: FeeOption[] = feeSummary.list.slice(0, FeeRateType.CUSTOM)
    let lowFeeSlowRate = false
    if (lowFeeModeApplies) {
      if (lowFeeRead?.summary !== feeSummary) return undefined
      if (lowFeeRead.lowFeeSummary) {
        const withSlowRate = withLowFeeSlowRate(list, lowFeeRead.lowFeeSummary)
        // Only a read with a slow rate to put in changes the list.
        lowFeeSlowRate = withSlowRate !== list
        list = withSlowRate
      }
    }

    const tiers = formatFeeRateTextKey(list, lowFeeSlowRate, t).map(
      (option, position): FeeBarOption => ({ ...option, index: position })
    )
    return {
      read: readName,
      options: readonly ? tiers : [...tiers, custom],
      quote: feeSummary.quote,
      readFailed: false,
      lowFeeMode: lowFeeSlowRate,
    }
  }, [readName, feeSummary, lowFeeModeApplies, lowFeeRead, t, readonly])

  // While a quote loads the bar keeps what it showed, and the rate selected
  // from it, rather than falling to a default rate.
  const [shownQuote, setShownQuote] = useState(NO_QUOTE_YET)
  if (readQuote !== undefined && readQuote !== shownQuote) setShownQuote(readQuote)
  const {
    read: shownRead,
    options: feeOptions,
    quote: feeQuote,
    readFailed,
  } = readQuote ?? shownQuote

  // A rate below 1 sat/vB only where the bar offers low-fee mode's slow rate
  // for the current quote: never before a quote arrives with its relay floor,
  // nor while its low-fee read is pending or after it failed.
  const supportLowFeeMode = readQuote?.lowFeeMode ?? false

  // After a failed read no tier is left to select, and the relay floor is the
  // rate in use: the input shows it rather than a tier's earlier rate.
  const floorInUse = readFailed && !readonly && feeOptionIndex !== FeeRateType.CUSTOM
  // The relay floor is also the rate in use from a tier of a quote without
  // estimates, which offers its tiers at the floor.
  const relayFloorInUse =
    floorInUse ||
    (!readonly &&
      feeQuote?.availability === 'unavailable' &&
      feeOptionIndex !== FeeRateType.CUSTOM &&
      optionAt(feeOptions, feeOptionIndex)?.feeRate === QBIT_MIN_RELAY_FEE_RATE)

  // Memoize default value to avoid repeated calculations
  const defaultFeeRate = useMemo(
    () => optionAt(feeOptions, AVG_OPTION_INDEX)?.feeRate ?? DEFAULT_FEE_RATE,
    [feeOptions]
  )

  useEffect(() => {
    // A read-only bar shows rates and picks none. The store's rate is the one
    // a send or consolidation screen uses, and the website PSBT risk popover
    // that shows a read-only bar shares the send screen's store.
    if (readonly) return
    let val: number
    // The read and option the rate is chosen for; none for a Custom rate.
    let source: FeeRateSource | null = null
    if (feeOptionIndex === FeeRateType.CUSTOM) {
      val = parseFloat(feeRateInputVal) || 0
    } else if (shownRead === undefined) {
      // Never a default rate before a quote lands: the selected rate stays.
      return
    } else {
      // From the read the bar shows, which while a newer one loads is an earlier one.
      // After a failed read no rates to select from: the relay floor, which the bar says it uses.
      // A tier the read does not offer falls back to a rate the read did not choose: no source.
      const option = optionAt(feeOptions, feeOptionIndex)
      val = readFailed ? QBIT_MIN_RELAY_FEE_RATE : (option?.feeRate ?? defaultFeeRate)
      source =
        readFailed || option !== undefined
          ? { quoteRead: shownRead, optionIndex: feeOptionIndex }
          : null
    }

    if (val === feeRate && sameFeeRateSource(feeRateSource, source)) return
    updateFeeRateBar({ feeRate: val, feeRateSource: source })
  }, [
    readonly,
    feeOptions,
    feeOptionIndex,
    feeRateInputVal,
    defaultFeeRate,
    feeRate,
    feeRateSource,
    readFailed,
    shownRead,
  ])

  const adjustFeeRateInput = useCallback(
    (inputVal: string) => {
      // When user manually changes the input, check if we need to switch to CUSTOM
      const shouldSwitchToCustom = feeOptionIndex !== FeeRateType.CUSTOM && feeOptions.length > 0
      // The rate the input shows for the selection: the selected tier's, or
      // the relay floor in use after a failed read.
      const selectedRate = floorInUse
        ? QBIT_MIN_RELAY_FEE_RATE
        : optionAt(feeOptions, feeOptionIndex)?.feeRate

      // If currently on SLOW/AVG/FAST and user changes the value, switch to CUSTOM
      if (shouldSwitchToCustom && selectedRate !== undefined) {
        const currentValue = selectedRate.toString()
        const parsedInput = Number(inputVal)
        const isSelectedRecommendation =
          inputVal === currentValue ||
          (inputVal.trim() !== '' &&
            !inputVal.endsWith('.') &&
            Number.isFinite(parsedInput) &&
            parsedInput === selectedRate)
        if (isSelectedRecommendation) {
          return
        }
      }

      const updateInputValue = (value: string) =>
        updateFeeRateBar({
          feeRateInputVal: value,
          feeOptionIndex:
            shouldSwitchToCustom && selectedRate !== undefined ? FeeRateType.CUSTOM : undefined,
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
    [
      defaultFeeRate,
      updateFeeRateBar,
      feeOptionIndex,
      feeOptions,
      floorInUse,
      supportLowFeeMode,
      isQbitChain,
    ]
  )

  const isCustomOption = useCallback((option: FeeOption) => option.type === FeeRateType.CUSTOM, [t])

  const setFeeOptionIndex = useCallback(
    (index: number) => {
      const selectedOption = optionAt(feeOptions, index)
      if (index !== FeeRateType.CUSTOM && selectedOption) {
        // When clicking on SLOW/AVG/FAST, show input and fill with the corresponding value
        updateFeeRateBar({
          feeOptionIndex: index,
          showCustomInput: true,
          feeRateInputVal: selectedOption.feeRate.toString(),
        })
      } else if (index === FeeRateType.CUSTOM) {
        // When clicking on CUSTOM, show input with current custom value or empty,
        // or with the relay floor in use rather than a tier's earlier rate
        updateFeeRateBar({
          feeOptionIndex: index,
          showCustomInput: true,
          ...(floorInUse ? { feeRateInputVal: String(QBIT_MIN_RELAY_FEE_RATE) } : {}),
        })
      }
    },
    [feeOptions, floorInUse, updateFeeRateBar]
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
    feeRateInputVal: floorInUse ? String(QBIT_MIN_RELAY_FEE_RATE) : feeRateInputVal,
    adjustFeeRateInput,
    isCustomOption,
    fontSize,
    isSpecialLocale,
    showCustomInput: readonly ? false : showCustomInput,
    toggleCustomInput,
    supportLowFeeMode,
    feeQuote,
    feeEstimateUnavailable: readFailed || feeQuote?.availability === 'unavailable',
    // The relay floor while it is the rate in use for want of estimates; none
    // for a Custom rate or a tier above it, nor for a read-only bar.
    fallbackFeeRate: relayFloorInUse ? QBIT_MIN_RELAY_FEE_RATE : undefined,
  }
}
