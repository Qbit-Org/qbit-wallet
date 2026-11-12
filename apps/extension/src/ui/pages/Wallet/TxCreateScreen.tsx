import { useMemo, useState } from 'react';

import { Button, Card, Column, Content, Header, Icon, Input, Layout, Row, Text, Tooltip } from '@/ui/components';
import { FeeRateBar } from '@/ui/components/FeeRateBar';
import { RBFBar } from '@/ui/components/RBFBar';
import { BulletedTip } from '@/ui/components/Tooltip/BulletedTip';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { useI18n, useTxCreateScreenLogic } from '@qbit/wallet-state';

// Numbers in the user's locale, with its own group and decimal separators. The
// app's locale codes (zh_TW) use an underscore where Intl expects a hyphen.
function localeNumberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale.replace('_', '-'), options);
  } catch {
    return new Intl.NumberFormat(undefined, options);
  }
}

// The send plan's card stays compact: it sits above Next in a 600px popup.
const $sendPlanCardStyle = { padding: '10px 12px' };

export default function TxCreateScreen() {
  const {
    headerTitle,
    chain,

    toInfo,
    onAddressInputChange,
    formKey,

    inputAmount,
    onAmountInputChange,
    onAmountMaxClick,
    enableRBF,
    onRBFChange,
    memo,
    onMemoChange,
    feeDetail,
    feeEstimatePending,
    leftBehindNote,
    spendSummary,
    feeQuote,

    showUnavailable,
    availableAmount,
    unavailableAmount,
    showImmature,
    immatureAmount,
    showPending,
    pendingAmount,
    unavailableTipText,
    qbitUnit,
    t,

    error,
    disabled,
    showConsolidate,
    consolidationNote,
    sendPlanNotice,
    sendPlanRefusal,
    sendPlanOpenText,

    onClickNext,
    onClickConsolidate,
    onClickMaxSendable,
    onClickViewSendPlan
  } = useTxCreateScreenLogic();
  const { locale } = useI18n();
  // The size in kB with one decimal, and the fee in whole bits.
  const sizeFormat = useMemo(
    () => localeNumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [locale]
  );
  const feeFormat = useMemo(() => localeNumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  // The estimate's inputs, size and fee, each `--` while pending.
  const feeEstimateText = (inputs: string, size: string, fee: string) =>
    `${t('estimated_inputs_and_size', [inputs, size])} · ${fee} bits`;

  // Keep an already-entered memo visible when returning to this screen. A
  // form the store clears for another account or network starts again as a
  // newly opened one, with Advanced closed as its memo is empty.
  const [advanced, setAdvanced] = useState(() => ({ formKey, expanded: Boolean(memo) }));
  const advancedExpanded = advanced.formKey === formKey ? advanced.expanded : Boolean(memo);
  const toggleAdvanced = () => setAdvanced({ formKey, expanded: !advancedExpanded });

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={headerTitle}
      />
      <Content style={{ padding: '0px 16px 24px' }}>
        <Column>
          <Column>
            {/* The address input keeps its own copy of the address: it starts
                again when the store clears the form for another account or network. */}
            <Input
              key={formKey}
              preset="address"
              addressInputData={toInfo}
              onAddressInputChange={onAddressInputChange}
              onAmountInputChange={onAmountInputChange}
              autoFocus={true}
              networkType={chain.enum}
              data-testid="recipient-address-input"
            />
          </Column>

          <Column mt="lg">
            <Text text={t('transfer_amount')} preset="regular" />
            <Input
              preset="amount"
              placeholder={t('tx_amount')}
              value={inputAmount}
              onAmountInputChange={onAmountInputChange}
              enableMax={true}
              onMaxClick={onAmountMaxClick}
              data-testid="transfer-amount-input"
            />
            {/* Right under the amount, where it shows without scrolling at the popup's height. */}
            {sendPlanRefusal ? (
              <Column gap="sm" fullX data-testid="tx-send-plan-refusal">
                <Text text={sendPlanRefusal.message} color="error" data-testid="tx-send-plan-refusal-message" />
                {sendPlanRefusal.offerText ? (
                  <Text text={sendPlanRefusal.offerText} size="sm" data-testid="tx-send-plan-offer" />
                ) : null}
                {sendPlanRefusal.unconfirmedText ? (
                  <Text
                    text={sendPlanRefusal.unconfirmedText}
                    size="xs"
                    color="textDim"
                    data-testid="tx-send-plan-unconfirmed"
                  />
                ) : null}
                {sendPlanRefusal.offerButtonText ? (
                  <Button
                    preset="defaultV2"
                    text={sendPlanRefusal.offerButtonText}
                    onClick={onClickMaxSendable}
                    data-testid="tx-send-plan-max-sendable"
                  />
                ) : null}
              </Column>
            ) : null}

            <Column gap="zero" fullX>
              <Row
                justifyBetween
                fullX
                itemsCenter
                style={{
                  minHeight: 30
                }}
              >
                <Text text={t('available')} color="gold" />
                <Row>
                  <Text text={`${availableAmount}`} preset="bold" size="sm" color="gold" />
                  <Text text={qbitUnit} size="sm" color="textDim" />
                </Row>
              </Row>

              {showUnavailable ? (
                <Row
                  style={{
                    width: '100%',
                    border: '1px dashed',
                    borderColor: colors.line
                  }}
                ></Row>
              ) : null}

              {showUnavailable ? (
                <Row
                  justifyBetween
                  fullX
                  itemsCenter
                  style={{
                    minHeight: 30
                  }}
                >
                  <Tooltip
                    title={<BulletedTip text={unavailableTipText} />}
                    placement="top"
                    autoAdjustOverflow={true}
                    align={{
                      overflow: {
                        adjustX: true,
                        adjustY: true
                      }
                    }}
                    overlayStyle={{
                      fontSize: fontSizes.xs,
                      maxWidth: '280px',
                      wordWrap: 'break-word',
                      whiteSpace: 'normal'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <Row itemsCenter>
                        <Text text={t('unavailable')} />
                        <Icon icon="circle-question" color="textDim" />
                      </Row>
                    </div>
                  </Tooltip>

                  <Row itemsCenter>
                    <Text text={`${unavailableAmount}`} size="sm" />
                    <Text text={qbitUnit} size="sm" color="textDim" />
                  </Row>
                </Row>
              ) : null}

              {showImmature ? (
                <Row justifyBetween fullX itemsCenter data-testid="immature-balance-row">
                  <Row itemsCenter style={{ paddingLeft: 12 }}>
                    <Text text={t('immature_coinbase')} size="xs" color="textDim" />
                  </Row>
                  <Row>
                    <Text text={`${immatureAmount}`} size="xs" color="textDim" />
                    <Text text={qbitUnit} size="xs" color="textDim" />
                  </Row>
                </Row>
              ) : null}
              {showPending ? (
                <Row justifyBetween fullX itemsCenter data-testid="pending-balance-row">
                  <Row itemsCenter style={{ paddingLeft: 12 }}>
                    <Text text={t('pending')} size="xs" color="textDim" />
                  </Row>
                  <Row>
                    <Text text={`${pendingAmount}`} size="xs" color="textDim" />
                    <Text text={qbitUnit} size="xs" color="textDim" />
                  </Row>
                </Row>
              ) : null}
            </Column>
          </Column>

          <Column mt="lg">
            <FeeRateBar
              quote={feeQuote}
              headerRight={
                feeDetail ? (
                  <Text
                    text={feeEstimateText(
                      String(feeDetail.inputCount),
                      sizeFormat.format(feeDetail.estimatedVsize / 1000),
                      feeFormat.format(feeDetail.estimatedFee)
                    )}
                    size="xs"
                    color="textDim"
                    data-testid="tx-size-estimate"
                  />
                ) : feeEstimatePending ? (
                  // Until the fee rate is settled, no estimate at an earlier rate.
                  <Text
                    text={feeEstimateText('--', '--', '--')}
                    size="xs"
                    color="textDim"
                    data-testid="tx-fee-estimate-pending"
                  />
                ) : null
              }
            />
            {feeDetail && feeDetail.changeDroppedSats > 0 ? (
              <Text
                text={t('change_below_dust_added_to_fee', [String(feeDetail.changeDroppedSats)])}
                size="xs"
                color="textDim"
                data-testid="tx-change-drop-note"
              />
            ) : null}
            {leftBehindNote ? (
              <Text text={leftBehindNote} size="xs" color="textDim" data-testid="tx-left-behind-note" />
            ) : null}
            {sendPlanNotice ? (
              <Card preset="style2" style={$sendPlanCardStyle} data-testid="tx-send-plan-notice">
                <Column gap="sm" fullX>
                  <Text text={sendPlanNotice.title} preset="bold" data-testid="tx-send-plan-title" />
                  <Text text={sendPlanNotice.steps} size="xs" color="textDim" data-testid="tx-send-plan-steps" />
                  <Row justifyBetween itemsCenter fullX>
                    <Text text={t('send_plan_receives')} size="xs" color="textDim" />
                    <Text text={sendPlanNotice.receives} size="xs" preset="bold" data-testid="tx-send-plan-receives" />
                  </Row>
                  <Row justifyBetween itemsCenter fullX>
                    <Text text={t('send_plan_total_fee')} size="xs" color="textDim" />
                    <Text text={sendPlanNotice.totalFee} size="xs" data-testid="tx-send-plan-total-fee" />
                  </Row>
                  <Row justifyBetween itemsCenter fullX>
                    <Text text={t('send_plan_signing_label')} size="xs" color="textDim" />
                    <Text text={sendPlanNotice.signing} size="xs" data-testid="tx-send-plan-signing" />
                  </Row>
                  {sendPlanNotice.leftBehind ? (
                    <Text
                      text={sendPlanNotice.leftBehind}
                      size="xs"
                      color="textDim"
                      data-testid="tx-send-plan-left-behind"
                    />
                  ) : null}
                  {sendPlanNotice.unconfirmed ? (
                    <Text
                      text={sendPlanNotice.unconfirmed}
                      size="xs"
                      color="textDim"
                      data-testid="tx-send-plan-unconfirmed-not-included"
                    />
                  ) : null}
                </Column>
              </Card>
            ) : null}
            {spendSummary ? (
              <Column gap="sm" fullX mt="md" data-testid="tx-spend-summary">
                <Row justifyBetween itemsCenter fullX>
                  <Text text={t('net_spend_leaves_wallet')} size="sm" color="textDim" />
                  <Text
                    text={`${spendSummary.totalSpend} ${qbitUnit}`}
                    preset="bold"
                    size="sm"
                    data-testid="tx-total-spend"
                  />
                </Row>
                {spendSummary.feeWarningTitle ? (
                  <Column gap="zero" fullX data-testid="tx-fee-warning">
                    <Text text={spendSummary.feeWarningTitle} preset="bold" size="sm" color="error" />
                    {spendSummary.feeWarnings.map((line, index) => (
                      <Text key={index} text={line} size="xs" color="error" />
                    ))}
                  </Column>
                ) : null}
                {spendSummary.feeRecommendationUnavailable ? (
                  <Text
                    text={spendSummary.feeRecommendationUnavailable}
                    size="xs"
                    color="warning"
                    data-testid="tx-fee-recommendation-unavailable"
                  />
                ) : null}
              </Column>
            ) : null}
          </Column>
          <Column mt="lg">
            <RBFBar value={enableRBF} onChange={onRBFChange} />
          </Column>

          <Column mt="lg">
            <Row itemsCenter onClick={toggleAdvanced} data-testid="advanced-toggle">
              <Text text={t('advanced')} preset="regular" color="textDim" />
              <Icon icon={advancedExpanded ? 'up' : 'down'} color="textDim" size={14} />
            </Row>
            {advancedExpanded ? (
              <Column>
                <Text text={t('memo')} preset="regular" />
                <Input
                  preset="text"
                  value={memo}
                  onChange={(e) => onMemoChange(e.target.value)}
                  data-testid="memo-input"
                />
              </Column>
            ) : null}
          </Column>

          {error && <Text text={error} color="error" data-testid="tx-create-error" />}

          {sendPlanOpenText ? (
            <Column gap="sm" fullX data-testid="tx-send-plan-open">
              <Text text={sendPlanOpenText} color="warning" />
              <Button
                preset="defaultV2"
                text={t('send_plan_view_open')}
                onClick={onClickViewSendPlan}
                data-testid="tx-send-plan-open-link"
              />
            </Column>
          ) : null}

          {showConsolidate ? (
            <Column>
              {consolidationNote ? (
                <Text text={consolidationNote} size="xs" color="textDim" data-testid="consolidation-send-note" />
              ) : null}
              <Button
                preset="default"
                text={t('consolidate_outputs')}
                onClick={onClickConsolidate}
                data-testid="tx-consolidate-button"
              />
            </Column>
          ) : null}

          <Button
            disabled={disabled}
            preset="primary"
            text={t('next')}
            onClick={onClickNext}
            data-testid="tx-next-button"
          ></Button>
        </Column>
      </Content>
    </Layout>
  );
}
