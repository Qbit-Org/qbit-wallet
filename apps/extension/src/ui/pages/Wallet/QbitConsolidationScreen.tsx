import { Button, Column, Content, Header, Layout, Text } from '@/ui/components';
import { FeeRateBar } from '@/ui/components/FeeRateBar';
import { useQbitConsolidationScreenLogic } from '@qbit/wallet-state';

export default function QbitConsolidationScreen() {
  const {
    headerTitle,
    description,
    statusText,
    pendingText,
    batch,
    batchSummary,
    error,
    canPrepare,
    feeQuote,
    onClickPrepare,
    onClickConfirm,
    t
  } = useQbitConsolidationScreenLogic();

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

          <Column mt="lg">
            <FeeRateBar quote={feeQuote} />
          </Column>

          {batchSummary ? <Text text={batchSummary} preset="regular" data-testid="consolidation-batch" /> : null}
          {error ? <Text text={error} color="error" data-testid="consolidation-error" /> : null}

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
