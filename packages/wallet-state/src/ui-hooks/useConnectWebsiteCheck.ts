import {
  WebsiteVerdictStatus,
  createUnverifiedWebsiteResult,
  type WebsiteSafetyResult,
} from '@qbit/wallet-shared'
import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { useWallet } from 'src/context'

export const CONNECT_WEBSITE_CHECK_TIMEOUT_MS = 8_000

export type WebsiteCheckStatus = 'checking' | 'blocked' | 'unverified' | 'clear'
export type ConnectWebsiteCheckStatus = WebsiteCheckStatus

export interface WebsiteSafetyCheckState {
  status: WebsiteCheckStatus
  result: WebsiteSafetyResult | undefined
  warning: string
  retry: () => void
  guardVersionRef: MutableRefObject<number>
  blockedRef: MutableRefObject<boolean>
}

const TIMEOUT_WARNING =
  'The local website-safety check timed out. Retry, reject, or continue only if you independently trust this site.'
const FAILURE_WARNING =
  'The local website-safety check failed. Retry, reject, or continue only if you independently trust this site.'

interface WebsiteCheckSnapshot {
  origin: string | undefined
  status: WebsiteCheckStatus
  result: WebsiteSafetyResult | undefined
}

const UNVERIFIED_REASONS = new Set([
  'malformed-origin',
  'unsupported-protocol',
  'insecure-protocol',
  'localhost',
  'private-network',
  'detector-failure',
  'timeout',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isWebsiteSafetyResult(value: unknown): value is WebsiteSafetyResult {
  if (!value || typeof value !== 'object') return false

  const candidate = value as {
    verdict?: unknown
    allowQuickMultiSign?: unknown
  }
  const verdict = candidate.verdict as
    | {
        status?: unknown
        reason?: unknown
        hostname?: unknown
        matchedDomain?: unknown
        warning?: unknown
      }
    | undefined
  if (
    !verdict ||
    typeof verdict !== 'object' ||
    typeof candidate.allowQuickMultiSign !== 'boolean'
  ) {
    return false
  }

  switch (verdict.status) {
    case WebsiteVerdictStatus.BLOCKED:
      return (
        verdict.reason === 'denylist' &&
        isNonEmptyString(verdict.hostname) &&
        isNonEmptyString(verdict.matchedDomain) &&
        isNonEmptyString(verdict.warning)
      )
    case WebsiteVerdictStatus.UNVERIFIED:
      return (
        typeof verdict.reason === 'string' &&
        UNVERIFIED_REASONS.has(verdict.reason) &&
        (verdict.hostname === undefined || isNonEmptyString(verdict.hostname)) &&
        isNonEmptyString(verdict.warning)
      )
    case WebsiteVerdictStatus.CLEAR:
      return (
        verdict.reason === 'not-listed' &&
        isNonEmptyString(verdict.hostname) &&
        verdict.warning === ''
      )
    default:
      return false
  }
}

/**
 * Runs a bounded website check and preserves conservative timeout semantics.
 * A late blocked verdict upgrades the UI; late clear/unverified results never
 * silently replace the timeout warning.
 */
export function useWebsiteSafetyCheck(
  origin: string | undefined,
  timeoutMs = CONNECT_WEBSITE_CHECK_TIMEOUT_MS
): WebsiteSafetyCheckState {
  const wallet = useWallet()
  const [snapshot, setSnapshot] = useState<WebsiteCheckSnapshot>({
    origin,
    status: origin ? 'checking' : 'clear',
    result: undefined,
  })
  const [attempt, setAttempt] = useState(0)
  const requestGenerationRef = useRef(0)
  const guardVersionRef = useRef(0)
  const blockedRef = useRef(false)

  useLayoutEffect(() => {
    if (!origin) {
      requestGenerationRef.current += 1
      guardVersionRef.current += 1
      blockedRef.current = false
      setSnapshot({ origin, status: 'clear', result: undefined })
      return undefined
    }

    const requestGeneration = ++requestGenerationRef.current
    guardVersionRef.current += 1
    blockedRef.current = false
    setSnapshot({ origin, status: 'checking', result: undefined })

    let timedOut = false
    const timeoutId = setTimeout(() => {
      if (requestGeneration !== requestGenerationRef.current) return

      timedOut = true
      const timeoutResult = createUnverifiedWebsiteResult('timeout', TIMEOUT_WARNING)
      setSnapshot({ origin, status: 'unverified', result: timeoutResult })
    }, timeoutMs)

    Promise.resolve()
      .then(() => wallet.checkWebsite(origin))
      .then(websiteResult => {
        if (requestGeneration !== requestGenerationRef.current) return

        clearTimeout(timeoutId)
        const validatedResult = isWebsiteSafetyResult(websiteResult)
          ? websiteResult
          : createUnverifiedWebsiteResult('detector-failure', FAILURE_WARNING)
        const nextStatus = validatedResult.verdict.status

        if (timedOut) {
          if (nextStatus !== WebsiteVerdictStatus.BLOCKED) return

          guardVersionRef.current += 1
          blockedRef.current = true
          setSnapshot({ origin, status: 'blocked', result: validatedResult })
          return
        }

        if (nextStatus === WebsiteVerdictStatus.BLOCKED) {
          guardVersionRef.current += 1
          blockedRef.current = true
        } else {
          blockedRef.current = false
        }
        setSnapshot({ origin, status: nextStatus, result: validatedResult })
      })
      .catch(() => {
        if (requestGeneration !== requestGenerationRef.current || timedOut) return

        clearTimeout(timeoutId)
        const failureResult = createUnverifiedWebsiteResult(
          'detector-failure',
          FAILURE_WARNING
        )
        blockedRef.current = false
        setSnapshot({ origin, status: 'unverified', result: failureResult })
      })

    return () => {
      clearTimeout(timeoutId)
      if (requestGeneration === requestGenerationRef.current) {
        requestGenerationRef.current += 1
        guardVersionRef.current += 1
      }
    }
  }, [attempt, origin, timeoutMs, wallet])

  const retry = useCallback(() => {
    requestGenerationRef.current += 1
    guardVersionRef.current += 1
    blockedRef.current = false
    setSnapshot({ origin, status: origin ? 'checking' : 'clear', result: undefined })
    setAttempt(value => value + 1)
  }, [origin])

  const isCurrentOrigin = snapshot.origin === origin
  const status = isCurrentOrigin ? snapshot.status : origin ? 'checking' : 'clear'
  const result = isCurrentOrigin ? snapshot.result : undefined

  return {
    status,
    result,
    warning: result?.verdict.warning || '',
    retry,
    guardVersionRef,
    blockedRef,
  }
}

export function useConnectWebsiteCheck(
  origin: string,
  timeoutMs = CONNECT_WEBSITE_CHECK_TIMEOUT_MS
): WebsiteSafetyCheckState {
  return useWebsiteSafetyCheck(origin, timeoutMs)
}
