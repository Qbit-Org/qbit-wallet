import { useState } from 'react';

import { Button, Checkbox, Column, Row, Text } from '@/ui/components';
import { BottomModal } from '@/ui/components/BottomModal';
import { requestRegtestHostPermission } from '@/ui/utils/regtestPermission';
import type { RegtestAccessStatus } from '@qbit/wallet-shared';
import { useI18n, useWallet } from '@qbit/wallet-state';

export type RegtestAccessOutcome = 'denied' | 'request_failed' | 'unreachable' | 'unexpected_service' | 'locked';

const OUTCOME_COPY: Record<RegtestAccessOutcome, string> = {
  denied: 'regtest_access_denied',
  request_failed: 'regtest_access_request_failed',
  unreachable: 'regtest_service_unavailable',
  unexpected_service: 'regtest_service_unexpected',
  locked: 'regtest_access_not_enabled'
};

function outcomeForStatus(status: RegtestAccessStatus): RegtestAccessOutcome | null {
  switch (status.state) {
    case 'available':
      return null;
    case 'unreachable':
      return 'unreachable';
    case 'unexpected_service':
      return 'unexpected_service';
    default:
      return 'locked';
  }
}

interface Props {
  onBack: () => void;
  onEnabled: (status: RegtestAccessStatus) => void;
}

/**
 * Informed-consent step before the wallet asks Chrome for the optional
 * loopback host permission. Modelled on the App Center warning: BottomModal
 * gets no onClose, so backdrop clicks do nothing; Cancel leaves without
 * persisting anything; Enable stays disabled until the acknowledgement is
 * checked. The acknowledgement itself is recorded by the background only
 * after it re-reads the granted permission.
 */
export default function RegtestAccessModal({ onBack, onEnabled }: Props) {
  const { t } = useI18n();
  const wallet = useWallet();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RegtestAccessOutcome | null>(null);

  const settle = (status: RegtestAccessStatus) => {
    const next = outcomeForStatus(status);
    if (next === null) {
      onEnabled(status);
      return;
    }
    setOutcome(next);
  };

  const handleEnable = () => {
    // Chrome only grants optional permissions inside the user gesture, so the
    // request is the first statement of this handler with no awaited work
    // before it. Its answer is only a hint: the background re-reads
    // permissions.contains() before recording consent or unlocking anything.
    const request = requestRegtestHostPermission();
    setBusy(true);
    request
      .then((granted) => {
        if (!granted) {
          setOutcome('denied');
          return undefined;
        }
        return wallet.acknowledgeRegtestAccess().then(settle);
      })
      .catch(() => {
        setOutcome('request_failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // Explicit retry re-runs the service verification only; it never re-opens
  // the browser prompt.
  const handleRetry = () => {
    setBusy(true);
    wallet
      .verifyRegtestAccess()
      .then(settle)
      .catch(() => {
        setOutcome('request_failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const canRetry = outcome === 'unreachable' || outcome === 'unexpected_service';

  return (
    <BottomModal>
      <Column gap="lg" data-testid="regtest-access-modal">
        <Text text={t('enable_local_regtest_title')} preset="title-bold" />
        {outcome === null ? (
          <>
            <Column gap="md">
              <Text text={t('regtest_access_no_value')} size="sm" wrap />
              <Text text={t('regtest_access_trust_note')} size="sm" wrap />
              <Text text={t('regtest_access_disable_note')} size="sm" wrap />
            </Column>
            <Checkbox
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="regtest-access-understand"
            >
              <Text text={t('regtest_access_acknowledgement')} preset="regular-bold" wrap />
            </Checkbox>
            <Row full>
              <Button
                text={t('cancel')}
                preset="defaultV2"
                full
                disabled={busy}
                data-testid="regtest-access-back"
                onClick={onBack}
              />
              <Button
                text={t('enable')}
                preset="primaryV2"
                full
                disabled={!understood || busy}
                data-testid="regtest-access-enable"
                onClick={handleEnable}
              />
            </Row>
          </>
        ) : (
          <>
            <Text text={t(OUTCOME_COPY[outcome])} size="sm" wrap data-testid="regtest-access-result" />
            <Row full>
              <Button
                text={t('cancel')}
                preset="defaultV2"
                full
                disabled={busy}
                data-testid="regtest-access-back"
                onClick={onBack}
              />
              {canRetry ? (
                <Button
                  text={t('regtest_access_retry')}
                  preset="primaryV2"
                  full
                  disabled={busy}
                  data-testid="regtest-access-retry"
                  onClick={handleRetry}
                />
              ) : null}
            </Row>
          </>
        )}
      </Column>
    </BottomModal>
  );
}
