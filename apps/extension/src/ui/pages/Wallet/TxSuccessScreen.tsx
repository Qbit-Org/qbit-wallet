import { Button, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { spacing } from '@/ui/theme/spacing';
import { shortAddress } from '@/ui/utils';
import { useTxSuccessScreenLogic } from '@qbit/wallet-state';

export default function TxSuccessScreen() {
  const { onClickDone, onClickContinueConsolidation, consolidation, t, txid, txAction } = useTxSuccessScreenLogic();

  return (
    <Layout>
      <Header />

      <Content style={{ gap: spacing.small }}>
        <Column justifyCenter mt="xxl" gap="xl">
          <Row justifyCenter>
            <Icon icon="success" size={50} style={{ alignSelf: 'center' }} />
          </Row>

          <Text preset="title" text={t('tx_sent_title')} textCenter />
          <Text preset="sub" text={t('tx_sent_desc')} color="textDim" textCenter />

          {txAction.type === 'explorer' ? (
            <Row justifyCenter itemsCenter clickable onClick={txAction.onClick}>
              <Icon icon="eye" color="textDim" />
              <Text preset="regular-bold" text={t('view_on_block_explorer')} color="textDim" />
            </Row>
          ) : (
            <Row justifyCenter itemsCenter clickable onClick={txAction.onClick}>
              <Icon icon="copy" color="textDim" />
              <Text preset="regular-bold" text={shortAddress(txid)} color="textDim" />
            </Row>
          )}
          <span data-testid="tx-success-txid" data-txid={txid} hidden />
        </Column>
      </Content>
      <Footer>
        <Column>
          {consolidation ? (
            <Button
              full
              preset="primary"
              text={t('consolidation_next_batch')}
              onClick={onClickContinueConsolidation}
              data-testid="tx-success-consolidate-button"
            />
          ) : null}
          <Button full text={t('done')} onClick={onClickDone} data-testid="tx-success-done-button" />
        </Column>
      </Footer>
    </Layout>
  );
}
