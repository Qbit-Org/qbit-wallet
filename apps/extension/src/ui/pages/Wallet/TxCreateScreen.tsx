import { useState } from 'react';

import { Button, Column, Content, Header, Icon, Input, Layout, Row, Text, Tooltip } from '@/ui/components';
import { FeeRateBar } from '@/ui/components/FeeRateBar';
import { RBFBar } from '@/ui/components/RBFBar';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { useTxCreateScreenLogic } from '@qbit/wallet-state';

export default function TxCreateScreen() {
  const {
    headerTitle,
    chain,

    toInfo,
    onAddressInputChange,

    inputAmount,
    onAmountInputChange,
    onAmountMaxClick,
    enableRBF,
    onRBFChange,
    memo,
    onMemoChange,
    feeDetail,
    leftBehindNote,
    spendSummary,

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

    onClickNext,
    onClickConsolidate
  } = useTxCreateScreenLogic();

  // Keep an already-entered memo visible when returning to this screen.
  const [advancedExpanded, setAdvancedExpanded] = useState(() => Boolean(memo));

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
            <Input
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
                    title={unavailableTipText}
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
              headerRight={
                feeDetail ? (
                  <Text
                    text={`${t('estimated_inputs_and_size', [
                      String(feeDetail.inputCount),
                      (feeDetail.estimatedVsize / 1000).toFixed(1)
                    ])} · ${feeDetail.estimatedFee} bits`}
                    size="xs"
                    color="textDim"
                    data-testid="tx-size-estimate"
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
            <Row itemsCenter onClick={() => setAdvancedExpanded(!advancedExpanded)} data-testid="advanced-toggle">
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

          {showConsolidate ? (
            <Column>
              <Text text={t('consolidation_send_note')} size="xs" color="textDim" />
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
