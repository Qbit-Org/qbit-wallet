import { CSSProperties, KeyboardEvent } from 'react';

import { Button, Column, Content, Header, Layout, Text } from '@/ui/components';
import { FeeRateBar } from '@/ui/components/FeeRateBar';
import { $baseContainerStyle, $baseInputStyle } from '@/ui/components/Input';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { typography } from '@/ui/theme/typography';
import { useQbitConsolidationScreenLogic } from '@qbit/wallet-state';

const BATCH_SIZE_INPUT_ID = 'consolidation-batch-size';
const BATCH_SIZE_HINT_ID = 'consolidation-batch-size-hint';
const COST_NOTE_ID = 'consolidation-cost-note';

const $labelStyle: CSSProperties = {
  fontFamily: typography.primary.regular,
  fontSize: 14,
  lineHeight: 1.45,
  color: colors.text
};

// The send screen's amount field: the shared input box, its text ending at
// the Max control as the amount's does.
const $batchSizeInputStyle: CSSProperties = Object.assign({}, $baseInputStyle, {
  padding: `${spacing.extraSmall}px 0 ${spacing.extraSmall}px ${spacing.medium}px`
});

// The amount field's MAX, as a real button: Tab reaches it, Enter and Space press it.
const $maxButtonStyle: CSSProperties = {
  alignSelf: 'stretch',
  padding: `0 ${spacing.extraSmall}px`,
  border: 0,
  background: 'transparent',
  color: colors.yellow,
  fontFamily: typography.primary.regular,
  fontSize: 14,
  cursor: 'pointer'
};

export default function QbitConsolidationScreen() {
  const {
    headerTitle,
    description,
    statusText,
    pendingText,
    batch,
    batchSummary,
    showBatchSize,
    batchSizeLabel,
    batchSizeText,
    batchSizeRange,
    batchSizeError,
    feePreview,
    costNote,
    error,
    canPrepare,
    feeQuote,
    onBatchSizeChange,
    onClickBatchSizeMax,
    onClickPrepare,
    onClickConfirm,
    t
  } = useQbitConsolidationScreenLogic();

  // Enter in the field does what the button below does, so the screen works
  // from the keyboard alone; not while an input method is composing, nor
  // again for a held key.
  const onBatchSizeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing) return;
    if (batch) {
      onClickConfirm();
    } else if (canPrepare) {
      onClickPrepare();
    }
  };

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
          <Text text={description} preset="sub" color="textDim" />
          {statusText ? <Text text={statusText} preset="regular" data-testid="consolidation-status" /> : null}
          {pendingText ? (
            <Text text={pendingText} size="xs" color="textDim" data-testid="consolidation-pending" />
          ) : null}

          {showBatchSize ? (
            <Column mt="lg" data-testid="consolidation-batch-size">
              <label htmlFor={BATCH_SIZE_INPUT_ID} style={$labelStyle}>
                {batchSizeLabel}
              </label>
              <div style={$baseContainerStyle}>
                <input
                  id={BATCH_SIZE_INPUT_ID}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={batchSizeText}
                  onChange={(event) => onBatchSizeChange(event.target.value)}
                  onKeyDown={onBatchSizeKeyDown}
                  aria-invalid={batchSizeError ? true : undefined}
                  aria-describedby={costNote ? `${BATCH_SIZE_HINT_ID} ${COST_NOTE_ID}` : BATCH_SIZE_HINT_ID}
                  style={$batchSizeInputStyle}
                  data-testid="consolidation-batch-size-input"
                />
                <button
                  type="button"
                  onClick={onClickBatchSizeMax}
                  style={$maxButtonStyle}
                  data-testid="consolidation-batch-size-max"
                >
                  {t('max')}
                </button>
              </div>
              {/* The range, or why the size is refused: either way the range stays in view. */}
              <div id={BATCH_SIZE_HINT_ID}>
                {batchSizeError ? (
                  <Text text={batchSizeError} size="xs" color="error" data-testid="consolidation-batch-size-error" />
                ) : (
                  <Text text={batchSizeRange} size="xs" color="textDim" data-testid="consolidation-batch-size-range" />
                )}
              </div>
              {costNote ? (
                <div id={COST_NOTE_ID}>
                  <Text text={costNote} size="xs" color="textDim" data-testid="consolidation-cost-note" />
                </div>
              ) : null}
            </Column>
          ) : null}

          <Column mt="lg">
            <FeeRateBar quote={feeQuote} />
            {feePreview ? (
              <Text text={feePreview} size="xs" color="textDim" data-testid="consolidation-fee-preview" />
            ) : null}
          </Column>

          {batchSummary ? <Text text={batchSummary} preset="regular" data-testid="consolidation-batch" /> : null}
          {/* A wallet error can hold an unbroken run longer than the popup is wide, such as a request URL. */}
          {error ? <Text text={error} color="error" wrap data-testid="consolidation-error" /> : null}

          {batch ? (
            <Button
              preset="primary"
              text={t('next')}
              onClick={onClickConfirm}
              data-testid="consolidation-confirm-button"
            />
          ) : (
            <Button
              disabled={!canPrepare}
              preset="primary"
              text={t('consolidation_prepare_batch')}
              onClick={onClickPrepare}
              data-testid="consolidation-prepare-button"
            />
          )}
        </Column>
      </Content>
    </Layout>
  );
}
