import { CSSProperties } from 'react';

import { Button, Card, Column, Content, Footer, Header, Layout, Row, Text } from '@/ui/components';
import { QbitRestoredFloorWarning } from '@/ui/components/QbitRestoredFloorWarning';
import { colors } from '@/ui/theme/colors';
import { useQbitSendPlanReviewScreenLogic } from '@qbit/wallet-state';

// The UI font's contextual alternates draw an "x" between two digits as a
// multiplication sign, which misprints an address.
const $addressStyle: CSSProperties = { fontVariantLigatures: 'no-contextual' };

const $revisionCardStyle: CSSProperties = {
  border: `1px solid ${colors.warning_content}`,
  backgroundColor: 'rgba(244, 182, 44, 0.08)'
};

function ReviewRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Row justifyBetween itemsCenter fullX gap="md">
      <Text text={label} size="sm" color="textDim" style={{ flexShrink: 0 }} />
      <Text text={value} size="sm" preset="bold" textEnd data-testid={testId} />
    </Row>
  );
}

/**
 * The one review of a payment that needs several transactions (#188): the
 * recipient, exactly what they receive, the transactions, every fee and the
 * signatures, then one confirmation. Reject and Confirm stay pinned.
 */
export default function QbitSendPlanReviewScreen() {
  const logic = useQbitSendPlanReviewScreenLogic();
  const { t } = logic;

  if (!logic.ready) {
    return (
      <Layout>
        <Header onBack={logic.onClickReject} title={t('send_plan_review_title')} />
        <Content style={{ padding: '0px 16px 16px' }}>
          <Text text={logic.unavailableText} color="error" data-testid="qbit-send-plan-review-unavailable" />
        </Content>
        <Footer>
          <Button full text={t('back')} onClick={logic.onClickReject} data-testid="qbit-send-plan-review-reject" />
        </Footer>
      </Layout>
    );
  }

  const {
    title,
    recipient,
    receives,
    transactions,
    totalFee,
    change,
    signing,
    budget,
    note,
    revision,
    restoredFloorRisk,
    riskAccepted,
    onRiskAcceptedChange,
    unusableText,
    planOpenText,
    error,
    confirming,
    canConfirm,
    onClickReject,
    onClickConfirm,
    onClickViewPlan
  } = logic;

  return (
    <Layout>
      <Header onBack={onClickReject} backDisabled={confirming} title={title} />
      <Content style={{ padding: '0px 16px 16px' }}>
        <Column gap="md" fullX>
          {revision ? (
            <Card style={$revisionCardStyle} data-testid="qbit-send-plan-review-revision">
              <Column gap="sm" fullX>
                <Text text={revision.title} preset="bold" color="warning" />
                {revision.lines.map((line, index) => (
                  <Text key={index} text={line} size="sm" data-testid="qbit-send-plan-review-revision-line" />
                ))}
              </Column>
            </Card>
          ) : null}

          <Card preset="style2" style={{ padding: '10px 12px' }}>
            <Column gap="sm" fullX>
              <Text text={t('recipient')} size="sm" color="textDim" />
              <Text
                text={recipient}
                size="sm"
                wrap
                selectText
                style={$addressStyle}
                data-testid="qbit-send-plan-review-recipient"
              />
              <ReviewRow label={t('send_plan_receives')} value={receives} testId="qbit-send-plan-review-receives" />
              <Text text={t('send_plan_review_transactions')} size="sm" color="textDim" />
              <Text text={transactions} size="sm" data-testid="qbit-send-plan-review-transactions" />
              <ReviewRow label={t('send_plan_total_fee')} value={totalFee} testId="qbit-send-plan-review-total-fee" />
              {change ? (
                <ReviewRow label={t('send_plan_review_change')} value={change} testId="qbit-send-plan-review-change" />
              ) : null}
              <ReviewRow label={t('send_plan_signing_label')} value={signing} testId="qbit-send-plan-review-signing" />
              <Text text={budget} size="xs" color="textDim" data-testid="qbit-send-plan-review-budget" />
            </Column>
          </Card>

          <Text text={note} size="xs" color="textDim" data-testid="qbit-send-plan-review-note" />

          {restoredFloorRisk ? (
            <QbitRestoredFloorWarning risk={restoredFloorRisk} checked={riskAccepted} onChange={onRiskAcceptedChange} />
          ) : null}

          {unusableText ? <Text text={unusableText} color="error" data-testid="qbit-send-plan-review-stale" /> : null}

          {planOpenText ? (
            <Column gap="sm" fullX data-testid="qbit-send-plan-review-plan-open">
              <Text text={planOpenText} color="warning" />
              <Button
                preset="defaultV2"
                text={t('send_plan_view_open')}
                onClick={onClickViewPlan}
                data-testid="qbit-send-plan-review-view-plan"
              />
            </Column>
          ) : null}

          {error ? <Text text={error} color="error" data-testid="qbit-send-plan-review-error" /> : null}
        </Column>
      </Content>
      <Footer>
        <Row full gap="md">
          <Button
            preset="default"
            full
            text={t('reject')}
            disabled={confirming}
            onClick={onClickReject}
            data-testid="qbit-send-plan-review-reject"
          />
          <Button
            preset="primary"
            full
            text={t('confirm')}
            loading={confirming}
            disabled={!canConfirm}
            onClick={() => void onClickConfirm()}
            data-testid="qbit-send-plan-review-confirm"
          />
        </Row>
      </Footer>
    </Layout>
  );
}
