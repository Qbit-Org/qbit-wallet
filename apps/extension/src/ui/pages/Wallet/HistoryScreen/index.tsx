import BigNumber from 'bignumber.js';
import { Clock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button, Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { Pagination } from '@/ui/components/Pagination';
import { HistoryDetail } from '@/ui/pages/Wallet/HistoryScreen/HistoryDetail';
import { isMixedFundingTransaction } from '@/ui/pages/Wallet/HistoryScreen/historyOwnership';
import { colors } from '@/ui/theme/colors';
import { satoshisToQbit, shortAddress } from '@/ui/utils';
import { TxHistoryItem } from '@qbit/wallet-shared';
import {
  useAccountAddress,
  useHistory,
  useHistoryAutoRefresh,
  useHistoryScopeKey,
  useI18n,
  useQbitUnit,
  useTools,
  useWallet
} from '@qbit/wallet-state';

interface ExtraItem {
  ticker: string;
  value: BigNumber;
  symbol: string;
  type: 'QBIT';
  div: number;
}

export interface HistoryItem {
  txid: string;
  address?: string;
  type: 'receive' | 'send' | 'self';
  qbitAmount: number;
  extra: ExtraItem[];
  confirmations: number;
  replaceable?: boolean;
  replaced?: boolean;
  feeRate: number;
  fee: number;
  size: number;
  outputValue: number;
  timestamp: number;
  transaction: TxHistoryItem;
}

interface GroupItem {
  date: string;
  historyItems: HistoryItem[];
  index: number;
}

interface HistoryPageResult {
  scopeKey: string;
  sessionKey?: string;
  page: number;
  groups: GroupItem[];
  total: number;
}

interface MyItemProps {
  group: GroupItem;
  index: number;
  onItemClick: (value: HistoryItem) => void;
}

export function AmountItem({
  item,
  inDetail,
  direction
}: {
  item: ExtraItem;
  inDetail?: boolean;
  direction?: HistoryItem['type'];
}) {
  const isReceived = item.value.isPositive();
  const isInternal = direction === 'self';

  return (
    <Row gap={'sm'} style={{ flexWrap: 'wrap' }} justifyEnd={!inDetail} justifyCenter={inDetail} itemsCenter>
      {!isInternal && !item.value.isZero() && (
        <Text text={isReceived ? '+' : '-'} color={isReceived ? 'green' : 'dangerText'} />
      )}
      {item.type === 'QBIT' && (
        <Text
          text={`${Number(item.value.abs().toNumber()).toLocaleString('en', { minimumFractionDigits: 8 })}`}
          ellipsis
          size={inDetail ? 'xl' : 'xs'}
        />
      )}
      <Text
        color={'textDim'}
        text={item.symbol || item.ticker}
        ellipsis
        style={{ maxWidth: inDetail ? undefined : 200 }}
        size={inDetail ? 'md' : 'xs'}
      />
    </Row>
  );
}

function MyItem({ group, index, onItemClick }: MyItemProps) {
  const { t } = useI18n();
  const qbitUnit = useQbitUnit();
  return (
    <Column key={index} style={{ position: 'relative' }} gap={'zero'}>
      <Text
        text={group.date}
        color="textDim"
        style={{ position: 'sticky', top: 0, backgroundColor: colors.background, marginLeft: 16 }}
        py={'md'}
      />
      <Column gap={'zero'}>
        {group.historyItems.map((item) => {
          const isMixedFunding = isMixedFundingTransaction(item.transaction);
          const isReceived = isMixedFunding ? item.qbitAmount >= 0 : item.type === 'receive';
          const isInternal = !isMixedFunding && item.type === 'self';
          return (
            <Row
              clickable
              justifyBetween
              full
              key={item.txid}
              data-testid={`history-item-${item.txid}`}
              data-transaction-status={item.replaced ? 'Replaced' : item.confirmations === 0 ? 'Pending' : 'Confirmed'}
              style={{
                borderBottom: `1px solid ${colors.border}`,
                padding: '12px 16px'
                // marginTop:
              }}
              onClick={() => {
                onItemClick(item);
              }}
            >
              <Row itemsCenter>
                {isInternal ? (
                  <svg
                    data-testid="history-icon-self"
                    xmlns="http://www.w3.org/2000/svg"
                    width="36"
                    height="36"
                    viewBox="0 0 36 36"
                    fill="none"
                  >
                    <rect width="36" height="36" rx="8" fill="url(#paint0_linear_self_transfer)" fillOpacity="0.12" />
                    <path
                      d="M12.9 14.9H23.1M23.1 14.9L20.1 11.9M23.1 14.9L20.1 17.9"
                      stroke="#7CA9FF"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M23.1 21.1H12.9M12.9 21.1L15.9 18.1M12.9 21.1L15.9 24.1"
                      stroke="#7CA9FF"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <defs>
                      <linearGradient
                        id="paint0_linear_self_transfer"
                        x1="30.75"
                        y1="2.625"
                        x2="3"
                        y2="31.125"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#7CA9FF" />
                        <stop offset="1" stopColor="#9AC1FF" />
                      </linearGradient>
                    </defs>
                  </svg>
                ) : isReceived ? (
                  <svg
                    data-testid="history-icon-receive"
                    xmlns="http://www.w3.org/2000/svg"
                    width="36"
                    height="36"
                    viewBox="0 0 36 36"
                    fill="none"
                  >
                    <rect width="36" height="36" rx="8" fill="url(#paint0_linear_5181_4125)" fillOpacity="0.12" />
                    <path
                      d="M21.9003 23.9965C22.5086 23.9965 23 23.505 23 22.8967V15.1985C23 14.5902 22.5086 14.0988 21.9003 14.0988C21.292 14.0988 20.8005 14.5902 20.8005 15.1985V20.2402L13.879 13.3221C13.4494 12.8925 12.7518 12.8925 12.3222 13.3221C11.8926 13.7517 11.8926 14.4493 12.3222 14.8789L19.2437 21.797H14.2021C13.5938 21.797 13.1023 22.2884 13.1023 22.8967C13.1023 23.505 13.5938 23.9965 14.2021 23.9965H21.9003Z"
                      fill="#7CDB98"
                    />
                    <defs>
                      <linearGradient
                        id="paint0_linear_5181_4125"
                        x1="30.75"
                        y1="2.625"
                        x2="3"
                        y2="31.125"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#77EBCF" />
                        <stop offset="1" stopColor="#60F9C6" />
                      </linearGradient>
                    </defs>
                  </svg>
                ) : (
                  <svg
                    data-testid="history-icon-send"
                    width="36"
                    height="36"
                    viewBox="0 0 36 36"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect width="36" height="36" rx="8" fill="url(#paint0_linear_5181_4101)" fillOpacity="0.15" />
                    <path
                      d="M23.9966 13.0997C23.9966 12.4914 23.5051 12 22.8968 12L15.1986 12C14.5903 12 14.0989 12.4914 14.0989 13.0997C14.0989 13.708 14.5903 14.1995 15.1986 14.1995L20.2403 14.1995L13.3222 21.121C12.8926 21.5506 12.8926 22.2482 13.3222 22.6778C13.7518 23.1074 14.4494 23.1074 14.879 22.6778L21.7971 15.7563L21.7971 20.7979C21.7971 21.4062 22.2885 21.8977 22.8968 21.8977C23.5051 21.8977 23.9966 21.4062 23.9966 20.7979L23.9966 13.0997Z"
                      fill="#FF8474"
                    />
                    <defs>
                      <linearGradient
                        id="paint0_linear_5181_4101"
                        x1="30.75"
                        y1="2.625"
                        x2="3"
                        y2="31.125"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#FF7665" />
                        <stop offset="1" stopColor="#FFA082" />
                      </linearGradient>
                    </defs>
                  </svg>
                )}

                <Column gap={'sm'}>
                  <Text
                    text={
                      isMixedFunding
                        ? t('mixed')
                        : isInternal
                          ? t('self_transfer')
                          : isReceived
                            ? t('receive')
                            : t('send')
                    }
                  />
                  <Text
                    text={
                      isInternal
                        ? t('within_your_account')
                        : item.address
                          ? isMixedFunding
                            ? shortAddress(item.address)
                            : `${isReceived ? t('from') : t('to')} ${shortAddress(item.address)}`
                          : t('address_unavailable')
                    }
                    preset="sub"
                  />
                  {item.replaced ? (
                    <Text text={t('replaced')} color="dangerText" preset="sub" />
                  ) : item.confirmations === 0 ? (
                    <Text text={t('pending')} color="warning" preset="sub" />
                  ) : item.confirmations < 60 ? (
                    <Text
                      text={`${item.confirmations} ${t('confirmations_count')} · ~${item.confirmations} ${t(
                        'minutes'
                      )}`}
                      color="textDim"
                      preset="sub"
                    />
                  ) : null}
                </Column>
              </Row>
              <Column style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                <AmountItem
                  direction={isMixedFunding ? undefined : item.type}
                  item={{
                    ticker: qbitUnit,
                    value: new BigNumber(item.qbitAmount),
                    type: 'QBIT',
                    div: 0,
                    symbol: qbitUnit
                  }}
                />
                {item.extra.map((extraItem, index) => {
                  return <AmountItem key={index} item={extraItem} />;
                })}
              </Column>
            </Row>
          );
        })}
      </Column>
    </Column>
  );
}

const pageSize = 20;

function toHistoryGroups(details: TxHistoryItem[], address: string, unavailableDate: string): GroupItem[] {
  const historyGroups: GroupItem[] = [];
  let lastDate = '';
  let lastGroup: GroupItem;
  let index = 0;
  details.forEach((v) => {
    const date = v.timestamp > 0 ? new Date(v.timestamp * 1000).toLocaleDateString() : unavailableDate;
    if (lastDate != date) {
      lastDate = date;
      lastGroup = { date, historyItems: [], index: index++ };
      historyGroups.push(lastGroup);
    }

    let addressNetAmount = new BigNumber(0);
    let ownedNetAmount = new BigNumber(0);
    let fromAddress = '';
    let toAddress = '';

    v.vin.forEach((vin) => {
      if (vin.owned) {
        ownedNetAmount = ownedNetAmount.minus(vin.value ?? 0);
      }
      if (vin.address === address) {
        addressNetAmount = addressNetAmount.minus(vin.value ?? 0);
      } else if (vin.address) {
        fromAddress = vin.address;
      }
    });

    v.vout.forEach((vout) => {
      if (vout.owned) {
        ownedNetAmount = ownedNetAmount.plus(vout.value ?? 0);
      }
      if (vout.address === address) {
        addressNetAmount = addressNetAmount.plus(vout.value ?? 0);
      } else if (vout.address) {
        toAddress = vout.address;
      }
    });

    const mixedFunding = isMixedFundingTransaction(v);
    const mixedNetAmount = v.netAmount ?? ownedNetAmount.toNumber();
    const type = v.direction ?? (addressNetAmount.isPositive() ? 'receive' : 'send');
    const amount = mixedFunding ? Math.abs(mixedNetAmount) : (v.amount ?? addressNetAmount.abs().toNumber());
    const signedAmount = mixedFunding ? mixedNetAmount : type === 'send' ? -amount : amount;
    const mixedParticipant =
      v.vin.find((input) => !input.owned && !input.coinbase && !input.prevoutMissing && input.address)?.address ||
      v.vout.find((output) => !output.owned && output.address)?.address;
    const counterparty = mixedFunding
      ? mixedParticipant
      : v.counterparties?.[0] || (type === 'receive' ? fromAddress : type === 'send' ? toAddress : undefined);
    const extra: ExtraItem[] = [];

    lastGroup.historyItems.push({
      txid: v.txid,
      address: counterparty,
      type,
      qbitAmount: satoshisToQbit(signedAmount),
      extra,
      confirmations: v.confirmations,
      replaceable: v.replaceable,
      replaced: v.replaced,
      feeRate: v.feeRate,
      fee: v.fee,
      size: v.size,
      outputValue: v.outputValue,
      timestamp: v.timestamp > 0 ? v.timestamp * 1000 : 0,
      transaction: v
    });
  });
  return historyGroups;
}

export default function HistoryScreen() {
  const address = useAccountAddress();
  const historyScopeKey = useHistoryScopeKey();
  const wallet = useWallet();
  const tools = useTools();
  const accountHistory = useHistory();
  const refreshHistory = useHistoryAutoRefresh();
  const { t } = useI18n();

  const [pagination, setPagination] = useState({ scopeKey: historyScopeKey, page: 1 });
  const page = pagination.scopeKey === historyScopeKey ? pagination.page : 1;
  // Qbit later pages read from one pinned background snapshot. Session state
  // without a snapshot id (e.g. persisted before snapshot ids existed) cannot
  // page safely, so hold the session unavailable until the auto-refresh pins a
  // fresh snapshot.
  const laterPageSnapshotMissing =
    historyScopeKey.startsWith('qbit-account:') && accountHistory.snapshotId === undefined;
  const laterPageSessionTxids =
    page === 1 || accountHistory.expired || laterPageSnapshotMissing
      ? undefined
      : accountHistory.list.map((item) => item.txid);
  const laterPageSessionKey = laterPageSessionTxids
    ? `${accountHistory.snapshotId ?? ''}|${laterPageSessionTxids.join(':')}|${
        accountHistory.verifiedPendingTxids?.join(':') ?? ''
      }`
    : undefined;
  const [historyPage, setHistoryPage] = useState<HistoryPageResult>();
  const [detail, setDetail] = useState<HistoryItem>();
  const [pageError, setPageError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (pagination.scopeKey !== historyScopeKey) {
      setPagination({ scopeKey: historyScopeKey, page: 1 });
      setHistoryPage(undefined);
      setDetail(undefined);
      setPageError(false);
    }
  }, [historyScopeKey, pagination.scopeKey]);

  useEffect(() => {
    if (!address) return;
    if (page === 1) {
      const loading = accountHistory.expired && !accountHistory.error;
      if (loading) tools.showLoading(true);
      return () => {
        if (loading) tools.showLoading(false);
      };
    }
    const laterPageSessionUnavailable = laterPageSessionTxids === undefined || laterPageSessionKey === undefined;
    if (laterPageSessionUnavailable && accountHistory.error) {
      setPageError(true);
      return;
    }

    let active = true;
    setPageError(false);
    const shouldShowLoading =
      historyPage?.scopeKey !== historyScopeKey ||
      historyPage?.sessionKey !== laterPageSessionKey ||
      historyPage?.page !== page;
    let loadingShown = false;
    if (shouldShowLoading) {
      tools.showLoading(true);
      loadingShown = true;
    }
    const hideLoading = () => {
      if (loadingShown) {
        loadingShown = false;
        tools.showLoading(false);
      }
    };
    if (laterPageSessionUnavailable) {
      return () => {
        active = false;
        hideLoading();
      };
    }
    const fetchPage = async () => {
      // Page 1 can include retained pending/replaced rows beyond the API's
      // first page. Build every later page from one immutable background
      // snapshot so retained rows cannot reappear at a page boundary.
      const displayedTxids = new Set(laterPageSessionTxids);
      const countedOmittedTxids = new Set<string>();
      const uniqueDetails: TxHistoryItem[] = [];
      const requiredUniqueCount = (page - 1) * pageSize;
      let nextStart = pageSize;
      let rawTotal = Number.POSITIVE_INFINITY;
      let omittedCount = 0;

      while (nextStart < rawTotal && uniqueDetails.length < requiredUniqueCount) {
        const res = await wallet.getAddressHistory({
          address,
          start: nextStart,
          limit: pageSize,
          snapshotId: accountHistory.snapshotId
        });
        if (!active) return undefined;
        if (
          (res.scopeKey !== undefined && res.scopeKey !== historyScopeKey) ||
          (accountHistory.snapshotId !== undefined && res.snapshotId !== accountHistory.snapshotId)
        ) {
          throw new Error('History snapshot changed while loading a page');
        }
        rawTotal = res.total;
        for (const item of res.detail) {
          if (displayedTxids.has(item.txid)) {
            if (!countedOmittedTxids.has(item.txid)) {
              countedOmittedTxids.add(item.txid);
              omittedCount += 1;
            }
          } else {
            displayedTxids.add(item.txid);
            if (uniqueDetails.length < requiredUniqueCount) uniqueDetails.push(item);
          }
        }
        if (res.detail.length === 0) break;
        nextStart += res.detail.length;
      }

      const detailStart = (page - 2) * pageSize;
      return {
        total: Math.max(0, rawTotal - omittedCount),
        detail: uniqueDetails.slice(detailStart, detailStart + pageSize)
      };
    };

    fetchPage()
      .then((res) => {
        if (!active || !res) return;
        const lastPage = Math.max(1, Math.ceil(res.total / pageSize));
        if (page > lastPage) {
          setPagination({ scopeKey: historyScopeKey, page: lastPage });
          return;
        }
        setHistoryPage({
          scopeKey: historyScopeKey,
          sessionKey: laterPageSessionKey,
          page,
          groups: toHistoryGroups(res.detail, address, t('date_unavailable')),
          total: res.total
        });
      })
      .catch(() => {
        if (active) setPageError(true);
      })
      .finally(hideLoading);

    return () => {
      active = false;
      hideLoading();
    };
  }, [address, page, laterPageSessionKey, historyScopeKey, accountHistory.expired, accountHistory.error, retryNonce]);

  const activeHistoryPage =
    historyPage?.scopeKey === historyScopeKey &&
    historyPage.sessionKey === laterPageSessionKey &&
    historyPage.page === page
      ? historyPage
      : undefined;
  const isLaterPageLoading = page > 1 && activeHistoryPage === undefined && !pageError;

  // Page 1 renders from the session history store once it has loaded: the
  // auto-refresh re-reads it from the live tip every block (60s), so
  // confirmation counts tick, reorged txs flip back to pending, and replaced
  // txs stay visible instead of silently disappearing.
  const displayGroups = useMemo(() => {
    if (page === 1 && !accountHistory.expired) {
      return toHistoryGroups(accountHistory.list, address, t('date_unavailable'));
    }
    return activeHistoryPage?.groups ?? [];
  }, [page, accountHistory, activeHistoryPage, address, t]);

  // Lifecycle probes can observe transactions that entered the mempool after
  // this pinned snapshot. Keep its raw total until later-page scanning actually
  // encounters and omits a displayed txid.
  const displayTotal = useMemo(() => {
    if (page === 1 && !accountHistory.expired) {
      const apiTotal = accountHistory.total ?? 0;
      return Math.max(Math.max(0, apiTotal), Math.min(accountHistory.list.length, pageSize));
    }
    return activeHistoryPage?.total ?? 0;
  }, [page, accountHistory, activeHistoryPage]);

  const displayError = page === 1 ? displayGroups.length === 0 && accountHistory.error : pageError;
  const displayCachedRefreshError = page === 1 && displayGroups.length > 0 && accountHistory.error;
  const retryHistory = () => {
    if (page === 1) {
      refreshHistory().catch(() => undefined);
    } else {
      refreshHistory()
        .then(() => setRetryNonce((value) => value + 1))
        .catch(() => undefined);
    }
  };

  return (
    <>
      <Layout>
        <Header
          onBack={() => {
            window.history.go(-1);
          }}
          title={t('history')}
        />

        {isLaterPageLoading ? (
          <Content />
        ) : displayError ? (
          <Content preset="middle">
            <Column gap="lg">
              <Text text={t('history_load_error')} color="dangerText" textCenter />
              <Button
                text={t('try_again')}
                preset="primary"
                data-testid="history-retry-button"
                onClick={retryHistory}
              />
            </Column>
          </Content>
        ) : displayGroups.length === 0 ? (
          <Content preset="middle">
            <Column gap="lg">
              <Row justifyCenter>
                <Icon color="textDim">
                  <Clock size="1em" />
                </Icon>
              </Row>
              <Text text={t('this_account_has_no_transactions')} color="textDim" textCenter />
            </Column>
          </Content>
        ) : (
          <Content style={{ padding: '0 0 16px' }}>
            <Column gap={'lg'}>
              {displayCachedRefreshError && (
                <Column gap="lg" style={{ padding: '12px 16px' }}>
                  <Text text={t('history_load_error')} color="dangerText" textCenter />
                  <Button
                    text={t('try_again')}
                    preset="primary"
                    data-testid="history-retry-button"
                    onClick={retryHistory}
                  />
                </Column>
              )}
              {displayGroups.map((data, index) => (
                <MyItem key={index} group={data} index={index} onItemClick={setDetail} />
              ))}
            </Column>{' '}
            <Row justifyCenter mt="lg">
              <Pagination
                pagination={{
                  currentPage: page,
                  pageSize
                }}
                total={displayTotal}
                onChange={(pagination) => {
                  setPagination({ scopeKey: historyScopeKey, page: pagination.currentPage });
                }}
              />
            </Row>
          </Content>
        )}
      </Layout>
      {detail && (
        <HistoryDetail
          detail={detail}
          close={() => {
            setDetail(undefined);
          }}
        />
      )}
    </>
  );
}
