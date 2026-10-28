import { Copy } from 'lucide-react';
import QRCode from 'qrcode.react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { AddressBar, Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { sizes } from '@/ui/theme/spacing';
import { shortAddress } from '@/ui/utils';
import { formatQbitUri as formatP2mrQbitUri } from '@qbit-oss/protocol';
import { formatQbitUri } from '@qbit/wallet-shared';
import type { QbitReceiveAddressState, QbitReceiveState } from '@qbit/wallet-shared';
import { useAccountAddress, useChain, useCurrentAccount, useI18n, useTools, useWallet } from '@qbit/wallet-state';

import './index.less';

type Translate = ReturnType<typeof useI18n>['t'];

const budgetKey = {
  normal: 'qbit_receive_budget_normal',
  warning: 'qbit_receive_budget_warning',
  critical: 'qbit_receive_budget_critical',
  exhausted: 'qbit_receive_budget_exhausted_badge'
} as const;

function BudgetDetails({ address, t }: { address: QbitReceiveAddressState; t: Translate }) {
  const counter = address.signatureCounter;
  if (counter.provenance === 'restored-floor') {
    return (
      <div className="receive-budget-copy" data-testid="restored-floor-budget-details">
        <span>{t('qbit_recovery_status_seed_only')}</span>
        <span>{t('qbit_counter_confidence_chain_floor_only')}</span>
        <span>{t('qbit_known_onchain_usage_lower_bound', `${counter.knownOnChainSignatures}+`)}</span>
      </div>
    );
  }
  const remaining = counter.remaining.toLocaleString();
  return (
    <div className="receive-budget-copy">
      <span>
        {counter.state === 'exhausted'
          ? t('qbit_receive_budget_exhausted')
          : t('qbit_receive_budget_available', remaining)}
      </span>
      <span>{t('qbit_receive_local_counter_help')}</span>
    </div>
  );
}

function StatusBadges({ address, t }: { address: QbitReceiveAddressState; t: Translate }) {
  return (
    <div className="receive-badges">
      <span className={`receive-badge ${address.used ? 'used' : 'unused'}`}>
        {t(address.used ? 'qbit_receive_used' : 'qbit_receive_unused')}
      </span>
      {/* A restored floor cannot substantiate a "Normal" budget claim, but its
          warning/critical/exhausted states are still actionable safety cues:
          ensureQbitReceiveIntent only blocks exhausted counters, so a low
          budget must stay visible before funds are deposited. */}
      {address.signatureCounter.provenance !== 'restored-floor' || address.signatureCounter.state !== 'normal' ? (
        <span
          className={`receive-badge budget-${address.signatureCounter.state}`}
          data-testid={`budget-state-${address.signatureCounter.state}`}
        >
          {t(budgetKey[address.signatureCounter.state])}
        </span>
      ) : null}
      <span
        className="receive-badge provenance"
        data-testid={`counter-provenance-${address.signatureCounter.provenance}`}
      >
        {t(
          address.signatureCounter.provenance === 'restored-floor'
            ? 'qbit_receive_restored_floor'
            : 'qbit_receive_local_counter'
        )}
      </span>
    </div>
  );
}

function BasicReceiveScreen() {
  const currentAccount = useCurrentAccount();
  const address = useAccountAddress();
  const qbitUri = formatQbitUri(address || '');
  const chain = useChain();
  const { t } = useI18n();

  return (
    <Layout>
      <Header onBack={() => window.history.go(-1)} title={t('address_label')} />
      <Content>
        <Column gap="xl" mt="lg">
          <Column
            justifyCenter
            rounded
            style={{ backgroundColor: 'white', alignSelf: 'center', alignItems: 'center', padding: 10 }}
          >
            <QRCode
              value={qbitUri}
              renderAs="svg"
              size={sizes.qrcode}
              imageRendering={IMAGE_SOURCE_MAP[chain.icon]}
              imageSettings={{
                src: IMAGE_SOURCE_MAP[chain.icon],
                width: 30,
                height: 30,
                excavate: true
              }}
            />
          </Column>
          <Row justifyCenter>
            <Icon icon="user" />
            <Text preset="regular-bold" text={currentAccount?.alianName} />
          </Row>
          <AddressBar />
        </Column>
      </Content>
    </Layout>
  );
}

export default function ReceiveScreen() {
  const currentAccount = useCurrentAccount();
  const chain = useChain();
  const wallet = useWallet();
  const tools = useTools();
  const { t } = useI18n();
  const [receiveState, setReceiveState] = useState<QbitReceiveState | null>(null);
  const [loadedContext, setLoadedContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const isP2mr = Boolean(currentAccount?.p2mr);
  const receiveKeyringScope = currentAccount?.key?.split('#')[0] || currentAccount?.pubkey || '';
  const receiveContext = `${receiveKeyringScope}:${chain.enum}`;
  const receiveContextRef = useRef(receiveContext);
  receiveContextRef.current = receiveContext;
  const visibleState = loadedContext === receiveContext ? receiveState : null;

  useEffect(() => {
    if (!isP2mr) return;
    let active = true;
    setLoading(true);
    setError('');
    void wallet
      .ensureQbitReceiveIntent()
      .then((state) => {
        if (active) {
          setReceiveState(state);
          setLoadedContext(receiveContext);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isP2mr, receiveContext, wallet]);

  const uriResult = useMemo(() => {
    if (!visibleState?.current) return { uri: '', error: '' };
    try {
      return {
        uri: formatP2mrQbitUri({
          address: visibleState.current.address,
          amount: amount || undefined,
          label: label || undefined
        }),
        error: ''
      };
    } catch {
      return { uri: '', error: t('qbit_uri_amount_invalid') };
    }
  }, [amount, label, visibleState?.current, t]);

  if (!isP2mr) return <BasicReceiveScreen />;

  const createNewAddress = async () => {
    setLoading(true);
    setError('');
    try {
      const state = await wallet.createQbitReceiveIntent();
      if (receiveContextRef.current !== receiveContext) return;
      setReceiveState(state);
      setLoadedContext(receiveContext);
      setAmount('');
      setLabel('');
    } catch (reason) {
      if (receiveContextRef.current !== receiveContext) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      tools.toastError(message);
    } finally {
      if (receiveContextRef.current === receiveContext) setLoading(false);
    }
  };

  const retry = async () => {
    setLoading(true);
    setError('');
    try {
      const state = await wallet.ensureQbitReceiveIntent();
      if (receiveContextRef.current !== receiveContext) return;
      setReceiveState(state);
      setLoadedContext(receiveContext);
    } catch (reason) {
      if (receiveContextRef.current !== receiveContext) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (receiveContextRef.current === receiveContext) setLoading(false);
    }
  };

  const copyPreviousAddress = async (address: QbitReceiveAddressState) => {
    if (address.signatureCounter.state === 'exhausted') {
      tools.toastError(t('qbit_receive_exhausted_copy_blocked'));
      return;
    }
    setCopying(true);
    try {
      const fresh = await wallet.ensureQbitReceiveIntent();
      if (receiveContextRef.current !== receiveContext) return;
      setReceiveState(fresh);
      setLoadedContext(receiveContext);
      if (fresh.activityStatus !== 'live') {
        tools.toastError(t('qbit_receive_activity_cached'));
        return;
      }
      const refreshed = [fresh.current, ...fresh.previous].find((item) => item?.address === address.address);
      if (!refreshed) {
        tools.toastError(t('qbit_receive_no_safe'));
        return;
      }
      if (refreshed.signatureCounter.state === 'exhausted') {
        tools.toastError(t('qbit_receive_exhausted_copy_blocked'));
        return;
      }
      if (refreshed.used) tools.toastWarning(t('qbit_receive_reuse_warning'));
      tools.copyToClipboard(address.address);
    } catch (reason) {
      if (receiveContextRef.current !== receiveContext) return;
      tools.toastError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (receiveContextRef.current === receiveContext) setCopying(false);
    }
  };

  const copyCurrent = async (copyUri: boolean) => {
    const selected = visibleState?.current;
    if (!selected || (copyUri && !uriResult.uri)) return;
    setCopying(true);
    try {
      const fresh = await wallet.ensureQbitReceiveIntent();
      if (receiveContextRef.current !== receiveContext) return;
      setReceiveState(fresh);
      setLoadedContext(receiveContext);
      if (fresh.activityStatus !== 'live') {
        tools.toastError(t('qbit_receive_activity_cached'));
        return;
      }
      const refreshed = [fresh.current, ...fresh.previous].find((item) => item?.address === selected.address);
      if (!refreshed) {
        tools.toastError(t('qbit_receive_no_safe'));
        return;
      }
      if (refreshed.signatureCounter.state === 'exhausted') {
        tools.toastError(t('qbit_receive_exhausted_copy_blocked'));
        return;
      }
      if (refreshed?.used) tools.toastWarning(t('qbit_receive_reuse_warning'));
      tools.copyToClipboard(copyUri ? uriResult.uri : selected.address);
    } catch (reason) {
      if (receiveContextRef.current !== receiveContext) return;
      tools.toastError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (receiveContextRef.current === receiveContext) setCopying(false);
    }
  };

  const current = visibleState?.activityStatus === 'live' ? visibleState.current : null;
  const imageSource = IMAGE_SOURCE_MAP[chain.icon];

  return (
    <Layout>
      <Header onBack={() => window.history.go(-1)} title={t('receive')} />
      <Content style={{ paddingTop: 12 }}>
        <div className="receive-shell">
          {loading && !visibleState ? (
            <div className="receive-empty" data-testid="receive-loading">
              {t('qbit_receive_loading')}
            </div>
          ) : null}

          {error ? (
            <div className="receive-notice error" role="alert">
              <span>{error}</span>
              <button onClick={retry}>{t('qbit_receive_retry')}</button>
            </div>
          ) : null}

          {visibleState?.activityStatus === 'cached' ? (
            <div className="receive-notice warning actionable" data-testid="activity-cached-warning">
              <span>{t('qbit_receive_activity_cached')}</span>
              <button onClick={() => void retry()}>{t('qbit_receive_retry')}</button>
            </div>
          ) : null}
          {visibleState?.floorsPending ? (
            <div className="receive-notice warning" data-testid="floors-pending-warning">
              {t('qbit_receive_floors_pending')}
            </div>
          ) : null}
          {visibleState?.concurrentInstanceHint ? (
            <div className="receive-notice critical" data-testid="concurrent-instance-warning">
              {t('qbit_receive_concurrent')}
            </div>
          ) : null}

          {current ? (
            <section className="receive-hero" aria-label={t('qbit_receive_current')}>
              {uriResult.uri ? (
                <div className="receive-qr-frame" data-testid="receive-qr">
                  <QRCode
                    value={uriResult.uri}
                    renderAs="svg"
                    size={sizes.qrcode}
                    imageRendering={imageSource}
                    imageSettings={{ src: imageSource, width: 30, height: 30, excavate: true }}
                  />
                </div>
              ) : (
                <div className="receive-qr-invalid" data-testid="receive-qr-invalid">
                  {t('qbit_uri_amount_invalid')}
                </div>
              )}
              <button
                className="receive-address-button"
                aria-label={t('copy_address')}
                data-qbit-address={current.address}
                disabled={copying}
                onClick={() => void copyCurrent(false)}
              >
                <span>{shortAddress(current.address)}</span>
                <Copy size="1em" />
              </button>
              <StatusBadges address={current} t={t} />
              <BudgetDetails address={current} t={t} />

              <div className="receive-fields">
                <label htmlFor="qbit-receive-amount">{t('qbit_receive_amount_optional')}</label>
                <input
                  id="qbit-receive-amount"
                  inputMode="decimal"
                  placeholder="0.00000000"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <label htmlFor="qbit-receive-label">{t('qbit_receive_label_optional')}</label>
                <input
                  id="qbit-receive-label"
                  maxLength={120}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                {uriResult.error ? <span className="receive-field-error">{uriResult.error}</span> : null}
              </div>

              <div className="receive-actions">
                <button
                  className="receive-action primary"
                  disabled={copying || Boolean(uriResult.error)}
                  onClick={() => void copyCurrent(true)}
                >
                  {t('qbit_receive_copy_uri')}
                </button>
                <button
                  className="receive-action"
                  data-testid="new-address"
                  disabled={loading || !visibleState?.gap.canCreate}
                  onClick={() => void createNewAddress()}
                >
                  {t('qbit_receive_new_address')}
                </button>
              </div>
            </section>
          ) : visibleState ? (
            <div className="receive-empty" data-testid="no-safe-receive-address">
              {t('qbit_receive_no_safe')}
            </div>
          ) : null}

          {visibleState &&
          visibleState.activityStatus === 'live' &&
          !visibleState.floorsPending &&
          !visibleState.gap.canCreate ? (
            <div className="receive-notice warning" data-testid="gap-limit-warning">
              {t('qbit_receive_gap_warning')}
            </div>
          ) : null}

          {visibleState?.activityStatus === 'live' && visibleState.previous.length ? (
            <section className="receive-previous" aria-label={t('qbit_receive_previous')}>
              <div className="receive-section-heading">
                <h2>{t('qbit_receive_previous')}</h2>
                <span>{visibleState.previous.length}</span>
              </div>
              <div className="receive-address-list">
                {visibleState.previous.map((address) => {
                  const exhausted = address.signatureCounter.state === 'exhausted';
                  return (
                    <article
                      className={`receive-address-card budget-${address.signatureCounter.state}`}
                      data-qbit-address={address.address}
                      key={address.address}
                    >
                      <div className="receive-address-card-top">
                        <code>{shortAddress(address.address, 10)}</code>
                        <button
                          aria-label={`${t('copy_address')} ${address.index}`}
                          disabled={copying || exhausted}
                          onClick={() => void copyPreviousAddress(address)}
                        >
                          <Copy size="1em" />
                        </button>
                      </div>
                      <StatusBadges address={address} t={t} />
                      <BudgetDetails address={address} t={t} />
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </Content>
    </Layout>
  );
}
