import { CSSProperties, useState } from 'react';

import { Button, Card, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { shortAddress } from '@/ui/utils';
import { useTxFailScreenLogic } from '@qbit/wallet-state';

const $warningCardStyle: CSSProperties = {
  border: `1px solid ${colors.warning_content}`,
  backgroundColor: 'rgba(244, 182, 44, 0.08)'
};

/**
 * Recovery screen for a broadcast that did not clearly succeed. Copy is
 * outcome-specific: `not_sent` is only shown when non-submission is proven,
 * `unknown` warns against a replacement payment. Sanitized technical detail
 * stays behind a collapsed disclosure; nothing raw reaches the primary copy.
 */
export default function TxFailScreen() {
  const {
    outcome,
    reason,
    txid,
    detail,
    canRetry,
    canCheckStatus,
    busy,
    isRetrying,
    isChecking,
    statusNotice,
    retryBlocked,
    onClickBack,
    onClickBackToWallet,
    onClickRetry,
    onClickCheckStatus,
    onClickCopyTxid,
    t
  } = useTxFailScreenLogic();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const isUnknown = outcome === 'unknown';
  const actionsDisabled = busy !== null;
  // A node's rejection is conclusive only once the follow-up lookups prove
  // the transaction absent. When they could not (the verdict is `unknown`),
  // the definitive "rejected" line would sit under a body saying the payment
  // may already have been accepted and push the user into sending it again,
  // so the reason keeps the error but not the certainty. A guard refusal is
  // `unknown` only when the wallet no longer holds this transaction's own
  // reservation, which is what an earlier broadcast whose answer was lost
  // leaves behind; the conflict line would be wrong and alarming there.
  const reasonKey =
    isUnknown && reason === 'rejected'
      ? 'tx_broadcast_reason_rejected_unconfirmed'
      : isUnknown && reason === 'guard_blocked'
        ? 'tx_broadcast_reason_guard_blocked_unconfirmed'
        : `tx_broadcast_reason_${reason}`;

  return (
    <Layout>
      <Header onBack={onClickBack} backDisabled={actionsDisabled} />

      <Content style={{ gap: spacing.small }}>
        <Column justifyCenter mt="xxl" gap="xl">
          <Row justifyCenter>
            <Icon icon="alert" size={50} color="warning" style={{ alignSelf: 'center' }} />
          </Row>

          <Text
            preset="title"
            text={isUnknown ? t('tx_unknown_title') : t('tx_not_sent_title')}
            textCenter
            data-testid="tx-fail-title"
          />
          <Text
            preset="sub"
            text={isUnknown ? t('tx_unknown_body') : t('tx_not_sent_body')}
            color="textDim"
            textCenter
            data-testid="tx-fail-body"
          />
          <Text preset="sub" text={t(reasonKey)} color="textDim" textCenter data-testid="tx-fail-reason" />

          {isUnknown ? (
            <Card style={$warningCardStyle} data-testid="tx-fail-replacement-warning">
              <Text text={t('tx_unknown_warning')} color="warning" wrap />
            </Card>
          ) : null}

          <Column gap="sm">
            <Text
              preset="sub"
              text={t('tx_broadcast_signature_notice')}
              color="textDim"
              data-testid="tx-fail-signature-notice"
            />
            <Text
              preset="sub"
              text={t('tx_broadcast_retry_notice')}
              color="textDim"
              data-testid="tx-fail-retry-notice"
            />
          </Column>

          {txid ? (
            <Row justifyCenter itemsCenter clickable onClick={onClickCopyTxid}>
              <Icon icon="copy" color="textDim" />
              <Text
                preset="regular-bold"
                text={`${t('transaction_id')}: ${shortAddress(txid)}`}
                color="textDim"
              />
            </Row>
          ) : null}
          <span data-testid="tx-fail-txid" data-txid={txid} data-outcome={outcome} hidden />

          {retryBlocked ? (
            <Text
              preset="sub"
              text={t('tx_broadcast_retry_blocked', [t(`tx_broadcast_reason_${retryBlocked}`)])}
              color="warning"
              textCenter
              data-testid="tx-fail-retry-blocked"
            />
          ) : null}

          {statusNotice ? (
            <Text
              preset="sub"
              text={statusNotice === 'gone' ? t('tx_broadcast_status_gone') : t('tx_broadcast_status_unavailable')}
              color="warning"
              textCenter
              data-testid="tx-fail-status-notice"
            />
          ) : null}

          {detail ? (
            <Column gap="sm">
              <Row
                justifyCenter
                itemsCenter
                clickable
                onClick={() => setDetailsExpanded((value) => !value)}
                data-testid="tx-fail-details-toggle">
                <Text preset="sub" text={t('tx_broadcast_technical_details')} color="textDim" />
                <Icon icon={detailsExpanded ? 'up' : 'down'} color="textDim" size={12} />
              </Row>
              {detailsExpanded ? (
                <Text
                  preset="sub"
                  text={detail}
                  color="textDim"
                  textCenter
                  wrap
                  selectText
                  data-testid="tx-fail-details"
                />
              ) : null}
            </Column>
          ) : null}
        </Column>
      </Content>

      <Footer>
        <Column gap="md">
          {canRetry ? (
            <Button
              preset="primary"
              full
              text={t('tx_broadcast_retry')}
              loading={isRetrying}
              disabled={actionsDisabled}
              onClick={onClickRetry}
              data-testid="tx-fail-retry-button"
            />
          ) : null}
          {canCheckStatus ? (
            <Button
              preset="defaultV2"
              full
              text={t('tx_broadcast_check_status')}
              loading={isChecking}
              disabled={actionsDisabled}
              onClick={onClickCheckStatus}
              data-testid="tx-fail-check-status-button"
            />
          ) : null}
          <Button
            preset="defaultV2"
            full
            text={t('tx_broadcast_back_to_wallet')}
            disabled={actionsDisabled}
            onClick={onClickBackToWallet}
            data-testid="tx-fail-back-button"
          />
        </Column>
      </Footer>
    </Layout>
  );
}
