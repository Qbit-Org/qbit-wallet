import BigNumber from 'bignumber.js';
import { useEffect, useRef, useState } from 'react';

import { Button, Card, Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { CopyableAddress } from '@/ui/components/CopyableAddress';
import { AmountItem, HistoryItem } from '@/ui/pages/Wallet/HistoryScreen/index';
import { isMixedFundingTransaction } from '@/ui/pages/Wallet/HistoryScreen/historyOwnership';
import { colors } from '@/ui/theme/colors';
import { satoshisToQbit } from '@/ui/utils';
import { TxHistoryInOutItem } from '@qbit/wallet-shared';
import { useChain, useI18n, useNavigation, useTools, useTxExplorerUrl, useWallet } from '@qbit/wallet-state';

interface HistoryDetailProps {
  detail: HistoryItem;
  close: () => void;
}

type RawTransactionState =
  | { status: 'loading'; txid: string }
  | { status: 'error'; txid: string }
  | { status: 'success'; txid: string; hex: string };

const RAW_HEX_PREVIEW_LENGTH = 192;

export function HistoryDetail({ detail, close }: HistoryDetailProps) {
  const chain = useChain();
  const isMixedFunding = isMixedFundingTransaction(detail.transaction);
  const isReceive = !isMixedFunding && detail.type === 'receive';
  const isSelf = !isMixedFunding && detail.type === 'self';
  const { t } = useI18n();
  const tools = useTools();
  const nav = useNavigation();
  const wallet = useWallet();
  const txExplorerUrl = useTxExplorerUrl(detail.txid);
  const [feeBumpAvailable, setFeeBumpAvailable] = useState(false);
  const [preparingFeeBump, setPreparingFeeBump] = useState(false);
  const feeBumpRequestRef = useRef(0);
  const canCheckFeeBump =
    !isMixedFunding &&
    (detail.type === 'send' || detail.type === 'self') &&
    detail.confirmations === 0 &&
    !detail.replaced;
  const [rawRetryNonce, setRawRetryNonce] = useState(0);
  const [rawTransaction, setRawTransaction] = useState<RawTransactionState>({
    status: 'loading',
    txid: detail.txid
  });
  const rawTransactionRequestRef = useRef(0);

  useEffect(() => {
    return () => {
      feeBumpRequestRef.current += 1;
    };
  }, [detail.txid]);

  useEffect(() => {
    let active = true;
    setFeeBumpAvailable(false);
    setPreparingFeeBump(false);
    if (!canCheckFeeBump) return () => undefined;

    wallet
      .getQbitFeeBumpEligibility(detail.txid)
      .then((eligibility) => {
        if (active) setFeeBumpAvailable(eligibility.eligible);
      })
      .catch(() => {
        if (active) setFeeBumpAvailable(false);
      });

    return () => {
      active = false;
    };
  }, [canCheckFeeBump, detail.txid, wallet]);

  useEffect(() => {
    const requestId = ++rawTransactionRequestRef.current;
    let active = true;
    setRawTransaction({ status: 'loading', txid: detail.txid });

    wallet
      .getQbitRawTransactionHex(detail.txid)
      .then((hex) => {
        if (active && rawTransactionRequestRef.current === requestId) {
          setRawTransaction({ status: 'success', txid: detail.txid, hex });
        }
      })
      .catch(() => {
        if (active && rawTransactionRequestRef.current === requestId) {
          setRawTransaction({ status: 'error', txid: detail.txid });
        }
      });

    return () => {
      active = false;
      if (rawTransactionRequestRef.current === requestId) {
        rawTransactionRequestRef.current += 1;
      }
    };
  }, [detail.txid, rawRetryNonce, wallet]);

  const bumpFee = async () => {
    if (preparingFeeBump) return;
    const requestId = ++feeBumpRequestRef.current;
    setPreparingFeeBump(true);
    try {
      const toSignData = await wallet.createBumpFeeQbitPsbt({ txid: detail.txid });
      if (feeBumpRequestRef.current !== requestId) return;
      nav.navigate('TxConfirmScreen', { toSignData });
    } catch (error) {
      if (feeBumpRequestRef.current !== requestId) return;
      console.error('Failed to prepare qbit fee replacement:', error);
      tools.toastError(t('fee_bump_unavailable'));
    } finally {
      if (feeBumpRequestRef.current === requestId) setPreparingFeeBump(false);
    }
  };

  const formatValue = (value: number | undefined) => {
    if (value === undefined) return t('value_unavailable');
    return `${Number(satoshisToQbit(value)).toLocaleString('en', {
      minimumFractionDigits: 8
    })} ${chain.unit}`;
  };

  const renderOwnership = (entry: TxHistoryInOutItem) => {
    const labels = [
      entry.owned ? t('wallet_owned') : undefined,
      entry.change ? t('change_output') : undefined,
      entry.internal ? t('internal_output') : undefined
    ].filter((label): label is string => Boolean(label));

    if (labels.length === 0) return null;
    return <Text text={labels.join(' · ')} color={'green'} preset="sub-bold" />;
  };

  const renderEntry = (entry: TxHistoryInOutItem, kind: 'input' | 'output') => {
    const isInput = kind === 'input';
    const label = `${t(isInput ? 'input_number' : 'output_number')} ${entry.index + 1}`;

    return (
      <section key={`${kind}-${entry.index}`} aria-label={label}>
        <Card
          data-testid={`history-detail-${kind}-${entry.index}`}
          style={{ alignItems: 'stretch', justifyContent: 'stretch' }}
        >
          <Column gap={'md'} style={{ flex: 1, minWidth: 0 }}>
            <Row justifyBetween itemsCenter>
              <Text text={label} preset="bold" />
              {renderOwnership(entry)}
            </Row>
            {isInput && entry.coinbase && <Text text={t('coinbase_input')} color={'textDim'} />}
            {isInput && entry.prevoutMissing && <Text text={t('previous_output_unavailable')} color={'warning'} />}
            {isInput && entry.prevTxid && entry.prevVout !== undefined && (
              <Column gap={'sm'}>
                <Text text={t('previous_output')} color={'textDim'} preset="sub" />
                <Text text={`${entry.prevTxid}:${entry.prevVout}`} selectText wrap disableTranslate />
              </Column>
            )}
            <Row justifyBetween itemsCenter>
              <Text text={t('value')} color={'textDim'} />
              <Text text={formatValue(entry.value)} />
            </Row>
            <Column gap={'sm'}>
              <Text text={t('address')} color={'textDim'} preset="sub" />
              {entry.address ? (
                <CopyableAddress address={entry.address} />
              ) : (
                <Text text={t('address_unavailable')} color={'textDim'} />
              )}
            </Column>
            <Row justifyBetween itemsCenter>
              <Text text={t('script_type')} color={'textDim'} />
              <Text text={entry.scriptType || t('script_type_unavailable')} />
            </Row>
            {entry.scriptPubKey && (
              <Column gap={'sm'}>
                <Text text={t('locking_script')} color={'textDim'} preset="sub" />
                <Text text={entry.scriptPubKey} selectText wrap disableTranslate />
              </Column>
            )}
          </Column>
        </Card>
      </section>
    );
  };

  const rawHex =
    rawTransaction.status === 'success' && rawTransaction.txid === detail.txid ? rawTransaction.hex : undefined;
  const rawHexPreview =
    rawHex && rawHex.length > RAW_HEX_PREVIEW_LENGTH ? `${rawHex.slice(0, RAW_HEX_PREVIEW_LENGTH)}…` : rawHex;

  return (
    <Layout
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        backgroundColor: colors.background
      }}
    >
      <Header onBack={close} title={t('transaction_details')} />
      <Content>
        <span data-testid="history-detail-txid" data-txid={detail.txid} hidden />
        <Card style={{ justifyContent: 'stretch' }} mt={'lg'}>
          <Column itemsCenter gap={'xl'} style={{ flex: 1 }}>
            {detail.replaced ? (
              <>
                {/*  dropped from the mempool without confirming: money did not move */}
                <Icon icon={'warning'} size={40} color={'dangerText'} />
                <Text text={t('replaced')} color={'dangerText'} />
              </>
            ) : detail.confirmations > 0 ? (
              <>
                <Icon icon={'success'} size={40} />
                <Text text={t('transaction_success')} color={'green'} />
                <Text text={`${detail.confirmations} ${t('confirmations_count')}`} color={'textDim'} preset="sub" />
              </>
            ) : (
              <>
                {/*  unconfirmed*/}
                <Icon icon={'warning'} size={40} color={'warning'} />
                <Text text={t('unconfirmed')} color={'warning'} />
              </>
            )}

            <Column itemsCenter>
              <AmountItem
                inDetail
                item={{
                  ticker: chain.unit,
                  value: new BigNumber(detail.qbitAmount),
                  type: 'QBIT',
                  div: 0,
                  symbol: chain.unit
                }}
                direction={isMixedFunding ? undefined : detail.type}
              />
              {detail.extra.map((extraItem, index) => {
                return <AmountItem key={index} item={extraItem} inDetail />;
              })}
            </Column>
            <div
              style={{
                alignSelf: 'stretch',
                borderBottom: `1px dashed ${colors.border}`
              }}
            />
            <Column gap={'xl'} style={{ alignSelf: 'stretch' }}>
              <Row justifyBetween>
                <Text
                  text={
                    isMixedFunding
                      ? t('mixed')
                      : isSelf
                        ? t('self_transfer')
                        : isReceive
                          ? t('received_from')
                          : t('send_to')
                  }
                  color={'textDim'}
                />
                {isSelf ? (
                  <Text text={t('within_your_account')} />
                ) : detail.address ? (
                  <CopyableAddress address={detail.address} />
                ) : (
                  <Text text={t('address_unavailable')} color={'textDim'} />
                )}
              </Row>
              <Row justifyBetween>
                <Text text={t('transaction_id')} color={'textDim'} />
                <CopyableAddress address={detail.txid} />
              </Row>
              <Row justifyBetween>
                <Text text={t('network_fee_2')} color={'textDim'} />
                <Row>
                  <Text
                    text={`${Number(Math.abs(satoshisToQbit(detail.fee))).toLocaleString('en', {
                      minimumFractionDigits: 8
                    })}`}
                  ></Text>
                  <Text text={chain.unit} color={'textDim'} />
                </Row>
              </Row>
              <Row justifyBetween>
                <Text text={t('network_fee_rate')} color={'textDim'} />
                <Row>
                  <Text text={detail.feeRate}></Text>
                  <Text text={'bits/vB'} color={'textDim'} />
                </Row>
              </Row>
              <Row justifyBetween>
                <Text text={t('size_bytes')} color={'textDim'} />
                <Row>
                  <Text text={`${detail.size}`}></Text>
                  <Text text={'B'} color={'textDim'} />
                </Row>
              </Row>
              <Row justifyBetween>
                <Text text={t('date')} color={'textDim'} />
                <Row>
                  <Text
                    text={detail.timestamp > 0 ? new Date(detail.timestamp).toLocaleString() : t('date_unavailable')}
                    color={'textDim'}
                  />
                </Row>
              </Row>
            </Column>
          </Column>
        </Card>

        <Column gap={'lg'} mt={'lg'}>
          <Text text={t('inputs')} preset="title" />
          {detail.transaction.vin.map((entry) => renderEntry(entry, 'input'))}
          <Text text={t('outputs')} preset="title" />
          {detail.transaction.vout.map((entry) => renderEntry(entry, 'output'))}
        </Column>

        <Card
          mt={'lg'}
          data-testid="history-detail-raw-transaction"
          style={{ alignItems: 'stretch', justifyContent: 'stretch' }}
        >
          <Column gap={'md'} style={{ flex: 1, minWidth: 0 }}>
            <Text text={t('raw_transaction_hex')} preset="title" />
            {rawTransaction.status === 'loading' || rawTransaction.txid !== detail.txid ? (
              <Text text={t('loading')} color={'textDim'} data-testid="raw-transaction-loading" />
            ) : rawTransaction.status === 'error' ? (
              <>
                <Text text={t('raw_transaction_load_error')} color={'dangerText'} data-testid="raw-transaction-error" />
                <Button
                  text={t('try_again')}
                  preset={'primary'}
                  onClick={() => setRawRetryNonce((value) => value + 1)}
                  data-testid="retry-raw-transaction"
                />
              </>
            ) : (
              <>
                <Text text={t('raw_transaction_preview')} color={'textDim'} preset="sub" />
                <Text
                  text={rawHexPreview}
                  selectText
                  wrap
                  disableTranslate
                  data-testid="history-detail-raw-hex-preview"
                />
                <Button
                  text={t('copy_raw_transaction')}
                  preset={'primary'}
                  onClick={() => {
                    if (rawHex) tools.copyToClipboard(rawHex);
                  }}
                  data-testid="copy-raw-transaction"
                />
              </>
            )}
          </Column>
        </Card>

        {feeBumpAvailable && (
          <Column gap={'lg'} mt={'lg'}>
            <Button
              text={t('bump_fee')}
              preset={'primary'}
              disabled={preparingFeeBump}
              onClick={bumpFee}
              data-testid="bump-fee-button"
            />
          </Column>
        )}

        {txExplorerUrl && (
          <Column gap={'lg'} mt={'lg'}>
            <Button
              text={t('view_on_block_explorer')}
              preset={'primary'}
              onClick={() => {
                tools.openUrl(txExplorerUrl);
              }}
            />
          </Column>
        )}
      </Content>
    </Layout>
  );
}
