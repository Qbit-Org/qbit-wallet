import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, Column, Row, Text } from '@/ui/components';
import type { PhishingProtectionReason } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import {
  PhishingMessageTimeoutError,
  type PhishingProtectionState,
  type PhishingProtectionView,
  plainError,
  readPhishingProtection,
  retryPhishingProtection,
  secondsUntilRetry
} from './phishingProtection';

/** How often the row reads the protection state again while it is shown. */
export const PHISHING_PROTECTION_REFRESH_MS = 5_000;

const STATE_LABELS: Record<PhishingProtectionState, string> = {
  protected: 'phishing_protection_status_protected',
  starting: 'phishing_protection_status_starting',
  retrying: 'phishing_protection_status_retrying',
  failed: 'phishing_protection_status_failed',
  unsupported: 'phishing_protection_status_unsupported',
  degraded: 'phishing_protection_status_degraded',
  unknown: 'phishing_protection_status_unknown'
};

const STATE_COLORS: Record<PhishingProtectionState, 'green' | 'warning' | 'error' | 'textDim'> = {
  protected: 'green',
  starting: 'textDim',
  retrying: 'warning',
  failed: 'error',
  unsupported: 'textDim',
  degraded: 'warning',
  unknown: 'warning'
};

const REASON_LABELS: Record<PhishingProtectionReason, string> = {
  'block-rule-not-installed': 'phishing_protection_reason_block_rule_not_installed',
  'block-rule-unknown': 'phishing_protection_reason_block_rule_unknown',
  'redirect-rule-without-host-access': 'phishing_protection_reason_redirect_rule_without_host_access',
  'redirect-rule-unknown': 'phishing_protection_reason_redirect_rule_unknown',
  'site-access-withheld': 'phishing_protection_reason_site_access_withheld',
  'site-access-unknown': 'phishing_protection_reason_site_access_unknown'
};

/** A failed Retry, shown while the row still reads the state it left. */
interface RetryFailure {
  /** The background's error, or null when it gave none. */
  error: string | null;
  timedOut: boolean;
  state: PhishingProtectionState;
}

/**
 * Advanced-settings row for phishing protection: whether the browser holds the
 * block rule for the bundled denylist and protection is full, as the
 * background reports it, with Retry now while it is not.
 */
export function PhishingProtectionCard() {
  const { t } = useI18n();
  const [view, setView] = useState<PhishingProtectionView | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<RetryFailure | null>(null);
  const mounted = useRef(true);
  const retryInFlight = useRef(false);
  // Only the latest read may set the state, so a slow earlier read cannot
  // overwrite a newer one.
  const latestRead = useRef(0);
  const readsInFlight = useRef(0);

  /** Reads the state and shows it; returns it, or null when a newer read or unmount overtook it. */
  const refresh = useCallback(async (): Promise<PhishingProtectionView | null> => {
    const read = ++latestRead.current;
    readsInFlight.current += 1;
    try {
      const next = await readPhishingProtection();
      if (!mounted.current || read !== latestRead.current) return null;
      setView(next);
      // A failed Retry is forgotten once a read finds a different state, so
      // a later read cannot bring it back.
      setRetryFailure((failure) => (failure && failure.state !== next.state ? null : failure));
      return next;
    } finally {
      readsInFlight.current -= 1;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // A poll waits for a slow read rather than overtaking it, so a read that
    // takes longer than the interval still lands.
    const timer = setInterval(() => {
      if (readsInFlight.current === 0) void refresh();
    }, PHISHING_PROTECTION_REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const onRetry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryFailure(null);
    try {
      let failure: Omit<RetryFailure, 'state'> | null = null;
      try {
        await retryPhishingProtection();
      } catch (error) {
        failure = {
          error: error instanceof Error && error.message ? error.message : null,
          timedOut: error instanceof PhishingMessageTimeoutError
        };
      }
      if (!mounted.current) return;
      const next = await refresh();
      if (failure && next) setRetryFailure({ ...failure, state: next.state });
    } finally {
      retryInFlight.current = false;
      if (mounted.current) setRetrying(false);
    }
  };

  const state = view?.state;
  const networkRules = view?.networkRules;
  const nextRetryAt = state === 'retrying' ? networkRules?.nextRetryAt : undefined;

  // Count down to the next attempt between reads, and stop once it is due.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextRetryAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= nextRetryAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [nextRetryAt]);

  const canRetry = !!view && state !== 'protected' && state !== 'unsupported';
  const details: string[] = [];
  if (state === 'retrying' && networkRules) {
    // `now` ticks only while a countdown runs, so it is stale on the first
    // render after entering retrying.
    const due = nextRetryAt === undefined ? null : secondsUntilRetry(nextRetryAt, Math.max(now, Date.now()));
    details.push(
      due === null
        ? t('phishing_protection_attempts', [String(networkRules.attempts)])
        : due === 'due'
        ? t('phishing_protection_next_attempt_due', [String(networkRules.attempts)])
        : t('phishing_protection_next_attempt_in', [String(networkRules.attempts), String(due)])
    );
  }
  if (networkRules?.error && state !== 'protected' && state !== 'unsupported') {
    details.push(t('phishing_protection_last_error', [plainError(networkRules.error)]));
  }
  if (networkRules && state !== 'unsupported') {
    details.push(
      networkRules.blockedDomains === null
        ? t('phishing_protection_blocked_domains_unknown')
        : t('phishing_protection_blocked_domains', [String(networkRules.blockedDomains)])
    );
  }

  const retryError =
    canRetry && retryFailure
      ? retryFailure.timedOut
        ? t('phishing_protection_retry_no_answer')
        : retryFailure.error
        ? t('phishing_protection_retry_failed_with', [retryFailure.error])
        : t('phishing_protection_retry_failed')
      : null;

  return (
    <Card style={{ borderRadius: 0 }} data-testid="phishing-protection-card">
      <Column fullX>
        <Row justifyBetween>
          <Text text={t('phishing_protection')} preset="bold" size="sm" />
          {state && (
            <Text
              text={t(STATE_LABELS[state])}
              color={STATE_COLORS[state]}
              size="sm"
              data-testid="phishing-protection-state"
            />
          )}
        </Row>
        {details.map((detail, index) => (
          <Text key={index} text={detail} color="textDim" size="xs" wrap />
        ))}
        {view?.reasons.map((reason, index) => (
          <Text
            key={index}
            text={t(REASON_LABELS[reason])}
            color="warning"
            size="xs"
            wrap
            data-testid="phishing-protection-reason"
          />
        ))}
        {canRetry && (
          <Button
            preset="defaultV2"
            text={t('phishing_protection_retry')}
            loading={retrying}
            disabled={retrying}
            onClick={() => void onRetry()}
            data-testid="phishing-protection-retry"
          />
        )}
        {retryError && (
          <Text text={retryError} color="error" size="xs" wrap data-testid="phishing-protection-retry-error" />
        )}
        <Text text={t('phishing_protection_list_note')} color="textDim" size="xs" wrap />
      </Column>
    </Card>
  );
}
