import { LoaderCircle } from 'lucide-react';
import { CSSProperties, ReactNode, useState } from 'react';

import { Button, Card, Column, Content, Footer, Header, Icon, Layout, Progress, Row, Text } from '@/ui/components';
import { FeeRateBar } from '@/ui/components/FeeRateBar';
import { Popover } from '@/ui/components/Popover';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { shortAddress } from '@/ui/utils';
import {
  QbitSendPlanNotice,
  QbitSendPlanRaiseDialog,
  QbitSendPlanScreenReady,
  QbitSendPlanStage,
  useQbitSendPlanScreenLogic
} from '@qbit/wallet-state';

// The UI font's contextual alternates draw an "x" between two digits as a
// multiplication sign, which misprints an address.
const $addressStyle: CSSProperties = { fontVariantLigatures: 'no-contextual' };

const $pausedCardStyle: CSSProperties = {
  border: `1px solid ${colors.warning_content}`,
  backgroundColor: 'rgba(244, 182, 44, 0.08)'
};

// Beside a primary action the others stay compact, in a row that wraps, so
// the plan's state above them stays in view at the popup's height.
const $compactButtonStyle: CSSProperties = { minHeight: 36, flex: '1 1 auto', paddingLeft: 8, paddingRight: 8 };
const $compactTextStyle: CSSProperties = { fontSize: fontSizes.xs };

function StageIcon({ state }: { state: QbitSendPlanStage['state'] }) {
  if (state === 'done') return <Icon icon="circle-check" size={fontSizes.md} color="green" />;
  if (state === 'active') {
    return (
      <Icon size={fontSizes.md} color="gold">
        <LoaderCircle className="icon-spin" size="1em" />
      </Icon>
    );
  }
  return <Icon icon="circle" size={fontSizes.md} color="textDim" />;
}

/**
 * A card on where the plan stands, above the stages so it stays in view at
 * the popup's height: its title, what happened, what the user can do now,
 * and where the funds are. `testId` names the card and its lines.
 */
function NoticeCard({
  notice,
  testId,
  children
}: {
  notice: QbitSendPlanNotice;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <Card style={$pausedCardStyle} data-testid={testId}>
      <Column gap="sm" fullX>
        <Text text={notice.title} preset="bold" color="warning" data-testid={`${testId}-title`} />
        {notice.body ? <Text text={notice.body} size="sm" data-testid={`${testId}-body`} /> : null}
        {notice.next ? <Text text={notice.next} size="sm" data-testid={`${testId}-next`} /> : null}
        {notice.funds ? (
          <Text text={notice.funds} size="sm" color="textDim" data-testid="qbit-send-plan-funds" />
        ) : null}
        {children}
      </Column>
    </Card>
  );
}

/**
 * The choice of a fee rate before a revision is prepared: a fee raise, or a
 * new plan for the same payment. `name` names its test ids.
 */
function RateDialog({
  dialog,
  busy,
  name
}: {
  dialog: QbitSendPlanRaiseDialog;
  busy: QbitSendPlanScreenReady['busy'];
  name: 'raise' | 'replan';
}) {
  const reviewing = name === 'raise' ? busy === 'raise_merge_fee' || busy === 'raise_payment_fee' : busy === 'replan';
  return (
    <Popover onClose={dialog.onClose} data-testid={`qbit-send-plan-${name}-dialog`}>
      <Column gap="md" fullX>
        <Text text={dialog.title} preset="bold" />
        <Text text={dialog.body} size="sm" color="textDim" />
        <FeeRateBar quote={dialog.feeQuote} />
        {dialog.error ? <Text text={dialog.error} size="xs" color="error" /> : null}
        <Row full gap="md">
          <Button
            preset="default"
            full
            text={dialog.closeText}
            disabled={busy !== null}
            onClick={dialog.onClose}
            data-testid={`qbit-send-plan-${name}-close`}
          />
          <Button
            preset="primary"
            full
            text={dialog.reviewText}
            loading={reviewing}
            disabled={!dialog.canReview}
            onClick={dialog.onReview}
            data-testid={`qbit-send-plan-${name}-review`}
          />
        </Row>
      </Column>
    </Popover>
  );
}

/**
 * The progress of a payment that needs several transactions (#188). The
 * background runs it whether or not this screen is open, so Back goes home
 * and stops nothing. The buttons are the actions the payment offers now.
 */
export default function QbitSendPlanScreen() {
  const logic = useQbitSendPlanScreenLogic();
  const { t } = logic;
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  if (!logic.ready) {
    return (
      <Layout>
        <Header onBack={logic.onClickBack} title={t('send_plan_header')} />
        <Content justifyCenter itemsCenter>
          {logic.readFailedText ? (
            <Text text={logic.readFailedText} color="textDim" textCenter data-testid="qbit-send-plan-read-failed" />
          ) : (
            <Icon size={fontSizes.xxxl} color="gold" data-testid="qbit-send-plan-loading">
              <LoaderCircle className="icon-spin" size="1em" />
            </Icon>
          )}
        </Content>
      </Layout>
    );
  }

  const {
    plan,
    title,
    amount,
    recipient,
    fee,
    stages,
    signing,
    note,
    slowMerge,
    pause,
    mayConfirm,
    cancelling,
    buttons,
    busy,
    actionError,
    readFailedText,
    raiseDialog,
    replanDialog,
    cancelDialog,
    onClickBack
  } = logic;
  const primaryButton = buttons.find((button) => button.primary);
  const otherButtons = buttons.filter((button) => button !== primaryButton);

  return (
    <Layout>
      <Header onBack={onClickBack} title={title} />
      <Content style={{ padding: '0px 16px 16px' }}>
        <Column gap="md" fullX data-testid="qbit-send-plan">
          <span data-testid="qbit-send-plan-state" data-phase={plan.phase} data-reason={plan.pause?.reason} hidden />
          {/* The terms the user confirmed come first, in view above any action; a stored
              payment the wallet cannot read has no amount, recipient or fee to show. */}
          {amount ? (
            <Column gap="zero" fullX itemsCenter>
              <Text text={amount} preset="title-bold" textCenter data-testid="qbit-send-plan-amount" />
              <Text
                text={t('send_plan_to', [shortAddress(recipient)])}
                size="xs"
                color="textDim"
                textCenter
                style={$addressStyle}
              />
              {fee ? <Text text={fee} size="xs" color="textDim" textCenter data-testid="qbit-send-plan-fee" /> : null}
            </Column>
          ) : null}

          {pause ? (
            <NoticeCard notice={pause} testId="qbit-send-plan-paused">
              {pause.detail ? (
                <Column gap="sm" fullX>
                  <Row
                    itemsCenter
                    clickable
                    onClick={() => setDetailsExpanded((value) => !value)}
                    data-testid="qbit-send-plan-details-toggle"
                  >
                    <Text text={t('tx_broadcast_technical_details')} size="xs" color="textDim" />
                    <Icon icon={detailsExpanded ? 'up' : 'down'} color="textDim" size={12} />
                  </Row>
                  {detailsExpanded ? (
                    <Text
                      text={pause.detail}
                      size="xs"
                      color="textDim"
                      wrap
                      selectText
                      data-testid="qbit-send-plan-details"
                    />
                  ) : null}
                </Column>
              ) : null}
            </NoticeCard>
          ) : null}

          {mayConfirm ? <NoticeCard notice={mayConfirm} testId="qbit-send-plan-may-confirm" /> : null}

          {cancelling ? (
            <Card style={$pausedCardStyle} data-testid="qbit-send-plan-cancelling">
              <Column gap="sm" fullX>
                <Text text={cancelling.title} preset="bold" />
                <Text text={cancelling.body} size="sm" />
                {cancelling.funds ? (
                  <Text text={cancelling.funds} size="sm" color="textDim" data-testid="qbit-send-plan-funds" />
                ) : null}
              </Column>
            </Card>
          ) : null}

          {stages.length > 0 ? (
            <Card preset="style2" style={{ padding: '10px 12px' }} data-testid="qbit-send-plan-stages">
              <Column gap="md" fullX>
                {stages.map((stage) => (
                  <Column key={stage.key} gap="sm" fullX data-testid={`qbit-send-plan-stage-${stage.key}`}>
                    <span data-testid={`qbit-send-plan-stage-${stage.key}-state`} data-state={stage.state} hidden />
                    <Row justifyBetween itemsCenter fullX gap="md">
                      <Row itemsCenter gap="md">
                        <StageIcon state={stage.state} />
                        <Text
                          text={stage.label}
                          size="sm"
                          preset={stage.state === 'active' ? 'bold' : 'regular'}
                          color={stage.state === 'pending' ? 'textDim' : 'text'}
                        />
                      </Row>
                      {stage.detail && stage.key !== 'signing' ? (
                        <Text text={stage.detail} size="xs" color="textDim" />
                      ) : null}
                    </Row>
                    {stage.key === 'signing' && signing ? (
                      <Column gap="sm" fullX>
                        <Progress
                          percent={signing.percent}
                          showInfo={false}
                          ariaLabel={stage.label}
                          ariaValueText={signing.count}
                          data-testid="qbit-send-plan-signing-bar"
                        />
                        <Row justifyBetween itemsCenter fullX gap="sm">
                          <Text text={signing.count} size="xs" data-testid="qbit-send-plan-signing-count" />
                          {signing.timeLeft ? (
                            <Text
                              text={signing.timeLeft}
                              size="xs"
                              color="textDim"
                              data-testid="qbit-send-plan-time-left"
                            />
                          ) : null}
                        </Row>
                        {signing.transaction ? (
                          <Text
                            text={signing.transaction}
                            size="xs"
                            color="textDim"
                            data-testid="qbit-send-plan-signing-transaction"
                          />
                        ) : null}
                      </Column>
                    ) : null}
                  </Column>
                ))}
              </Column>
            </Card>
          ) : null}

          {note ? <Text text={note} size="xs" color="textDim" data-testid="qbit-send-plan-note" /> : null}
          {slowMerge ? (
            <Text text={slowMerge} size="xs" color="warning" data-testid="qbit-send-plan-slow-merge" />
          ) : null}
          {readFailedText ? (
            <Text text={readFailedText} size="xs" color="textDim" data-testid="qbit-send-plan-read-failed" />
          ) : null}
          {actionError ? <Text text={actionError} color="error" data-testid="qbit-send-plan-error" /> : null}
        </Column>

        {raiseDialog ? <RateDialog dialog={raiseDialog} busy={busy} name="raise" /> : null}
        {replanDialog ? <RateDialog dialog={replanDialog} busy={busy} name="replan" /> : null}

        {cancelDialog ? (
          <Popover onClose={cancelDialog.onClose} data-testid="qbit-send-plan-cancel-dialog">
            <Column gap="md" fullX>
              <Text text={cancelDialog.title} preset="bold" />
              <Text text={cancelDialog.body} size="sm" data-testid="qbit-send-plan-cancel-body" />
              <Row full gap="md">
                <Button
                  preset="default"
                  full
                  text={cancelDialog.keepText}
                  disabled={busy !== null}
                  onClick={cancelDialog.onClose}
                  data-testid="qbit-send-plan-cancel-keep"
                />
                <Button
                  preset="danger"
                  full
                  text={cancelDialog.confirmText}
                  loading={busy === 'cancel'}
                  disabled={busy !== null}
                  onClick={cancelDialog.onConfirm}
                  data-testid="qbit-send-plan-cancel-confirm"
                />
              </Row>
            </Column>
          </Popover>
        ) : null}
      </Content>

      {buttons.length > 0 ? (
        <Footer>
          <Column gap="sm" full>
            {primaryButton ? (
              <Button
                preset="primary"
                full
                text={primaryButton.text}
                loading={busy === primaryButton.action}
                disabled={busy !== null}
                onClick={primaryButton.onClick}
                data-testid={`qbit-send-plan-action-${primaryButton.action}`}
              />
            ) : null}
            {primaryButton && otherButtons.length > 0 ? (
              <Row gap="sm" fullX style={{ flexWrap: 'wrap' }} data-testid="qbit-send-plan-more-actions">
                {otherButtons.map((button) => (
                  <Button
                    key={button.action}
                    preset="defaultV2"
                    text={button.text}
                    style={$compactButtonStyle}
                    textStyle={$compactTextStyle}
                    loading={busy === button.action}
                    disabled={busy !== null}
                    onClick={button.onClick}
                    data-testid={`qbit-send-plan-action-${button.action}`}
                  />
                ))}
              </Row>
            ) : null}
            {primaryButton
              ? null
              : otherButtons.map((button) => (
                  <Button
                    key={button.action}
                    preset="defaultV2"
                    full
                    text={button.text}
                    loading={busy === button.action}
                    disabled={busy !== null}
                    onClick={button.onClick}
                    data-testid={`qbit-send-plan-action-${button.action}`}
                  />
                ))}
          </Column>
        </Footer>
      ) : null}
    </Layout>
  );
}
