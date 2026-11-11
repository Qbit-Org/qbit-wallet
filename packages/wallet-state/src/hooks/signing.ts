import { BUS_METHODS, QbitSigningProgress } from '@qbit/wallet-shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { uiEventBus } from '../utils/eventBus'

/** What a signing screen shows while a local signing it started runs. */
export interface SigningProgressState {
  /**
   * Inputs signed so far, cached signatures included, out of `total`.
   * Unknown until the signer reports its first count.
   */
  signed?: number
  total?: number
  /** In a batch of several transactions: the one signing (from 0), and how many there are. */
  transactionIndex?: number
  transactionCount?: number
  /**
   * Time left at the rate measured over the last inputs, in milliseconds.
   * Unknown until a few inputs have been timed.
   */
  remainingMs?: number
}

export interface SigningProgressTransaction {
  index: number
  count: number
}

/** One progress count and when it arrived. */
export interface SigningProgressSample {
  signed: number
  /** Of `signed`, the inputs whose signature came from the cache. */
  cached: number
  at: number
}

interface SigningRun {
  id: string
  transaction?: SigningProgressTransaction
  /** The last counts, oldest first. */
  samples: SigningProgressSample[]
}

// The rate comes from the last few inputs, so it follows the signer's pace.
const RATE_SAMPLES = 12
const MIN_TIMED_INPUTS = 3

let progressIdSequence = 0

/** A fresh id that matches the background's `progressId` rule. */
function newProgressId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return random
  progressIdSequence += 1
  return `signing-${Date.now().toString(36)}-${progressIdSequence.toString(36)}`
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Milliseconds left at the rate the samples' new signatures took, or unknown
 * until three have been timed. A signature from the cache comes back at once
 * and is not counted, so a retry whose first inputs are cached does not look
 * nearly done. The inputs left are all counted as new signatures, so the
 * estimate errs long.
 */
export function estimateSigningRemainingMs(
  samples: readonly SigningProgressSample[],
  total: number
): number | undefined {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || last.signed >= total) return undefined
  const newSignatures = last.signed - last.cached - (first.signed - first.cached)
  const ms = last.at - first.at
  if (newSignatures < MIN_TIMED_INPUTS || ms <= 0) return undefined
  return (ms / newSignatures) * (total - last.signed)
}

/**
 * Follow the progress of the local signings this page starts. `start` hands
 * out the `progressId` to pass to the signing call, and only that call's
 * events show: an earlier signing's, or another page's, never do. `stop`
 * with the same id ends it.
 */
export function useSigningProgress() {
  const [progress, setProgress] = useState<SigningProgressState | null>(null)
  const runRef = useRef<SigningRun | null>(null)

  useEffect(() => {
    const onProgress = (event?: Partial<QbitSigningProgress>) => {
      const run = runRef.current
      if (!run || event?.progressId !== run.id) return
      const { signed, total, cached } = event
      if (
        typeof signed !== 'number' ||
        typeof total !== 'number' ||
        typeof cached !== 'number' ||
        !Number.isSafeInteger(signed) ||
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(cached) ||
        signed < 0 ||
        signed > total ||
        cached < 0 ||
        cached > signed
      ) {
        return
      }
      run.samples = [...run.samples, { signed, cached, at: monotonicNow() }].slice(-RATE_SAMPLES)
      setProgress({
        signed,
        total,
        transactionIndex: run.transaction?.index,
        transactionCount: run.transaction?.count,
        remainingMs: estimateSigningRemainingMs(run.samples, total),
      })
    }
    uiEventBus.addEventListener(BUS_METHODS.QBIT_SIGNING_PROGRESS, onProgress)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.QBIT_SIGNING_PROGRESS, onProgress)
      runRef.current = null
    }
  }, [])

  const start = useCallback((transaction?: SigningProgressTransaction): string => {
    const id = newProgressId()
    runRef.current = { id, transaction, samples: [] }
    setProgress({ transactionIndex: transaction?.index, transactionCount: transaction?.count })
    return id
  }, [])

  const stop = useCallback((id: string) => {
    if (runRef.current?.id !== id) return
    runRef.current = null
    setProgress(null)
  }, [])

  return { progress, start, stop }
}
