import { LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button, Card, Column, Icon, Input, Row, Text } from '@/ui/components';
import { AddressTypeCard2 } from '@/ui/components/AddressTypeCard';
import { FooterButtonContainer } from '@/ui/components/FooterButtonContainer';
import { ContextData, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { useNavigate } from '@/ui/pages/MainRoute';
import { fontSizes } from '@/ui/theme/font';
import { satoshisToAmount } from '@/ui/utils';
import {
  ADDRESS_TYPES,
  QbitRestoreReport,
  getAccountDerivationPath,
  getQbitHdPathForChainType
} from '@qbit/wallet-shared';
import {
  useChainType,
  useCreateAccountCallback,
  useI18n,
  useRestoreQbitWalletCallback,
  useTools,
  useWallet
} from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';

function formatRestoreNetwork(network: QbitRestoreReport['network']) {
  return `${network.charAt(0).toUpperCase()}${network.slice(1)}`;
}

export function Step2({
  contextData,
  updateContextData
}: {
  contextData: ContextData;
  updateContextData: (params: UpdateContextDataParams) => void;
}) {
  const wallet = useWallet();
  const tools = useTools();
  const { t } = useI18n();
  const chainType = useChainType();
  const qbitHdPath = useMemo(() => getQbitHdPathForChainType(chainType), [chainType]);

  const hdPathOptions = useMemo(() => {
    const p2mr = ADDRESS_TYPES.find((v) => v.value === AddressType.P2MR);
    if (!p2mr) {
      return [];
    }
    return [
      {
        label: p2mr.name,
        hdPath: qbitHdPath,
        addressType: p2mr.value,
        usesBip44Path: false
      }
    ];
  }, [qbitHdPath]);

  const [previewAddresses, setPreviewAddresses] = useState<string[]>(hdPathOptions.map((v) => ''));

  const [addressAssets, setAddressAssets] = useState<{
    [key: string]: { totalAmount: string; satoshis: number };
  }>({});

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [phase, setPhase] = useState<'form' | 'scanning' | 'report'>('form');
  const [report, setReport] = useState<QbitRestoreReport | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [concurrentHint, setConcurrentHint] = useState(false);
  const restoreInProgress = useRef(false);
  // Authoritative passphrase: seeded at mount, then written only by the input's
  // onChange. Never synced back from contextData — a stale parent update must
  // not be able to overwrite what the user typed.
  const passphraseRef = useRef(contextData.passphrase);
  const previewGeneration = useRef(0);

  const createAccount = useCreateAccountCallback();
  const restoreQbitWallet = useRestoreQbitWalletCallback();
  const navigate = useNavigate();
  const [counterMinimumWarning, counterReuseWarning] = t('qbit_restore_counters_minimum_warning').split(
    '\n\n'
  );

  const [recommendedTypeIndex, setRecommendedTypeIndex] = useState(0);

  useEffect(() => {
    const option = hdPathOptions[recommendedTypeIndex];
    if (option) {
      updateContextData({ addressType: option.addressType, addressTypeIndex: recommendedTypeIndex });
    }
  }, [recommendedTypeIndex]);

  // The back button and step tabs live in the parent screen; mirror the
  // scanning phase into shared context so it can lock them while a chain
  // scan is in flight. Floor-scan retries re-enter the same uncancellable
  // scan from the report, so they hold the lock too. Effects run only after
  // paint while the restore RPC starts immediately, so the scan entry points
  // below also raise the flag imperatively — this mirror reconciles it and
  // clears it when scanning ends. The cleanup keeps the flag from sticking
  // if this step ever unmounts mid-scan.
  useEffect(() => {
    updateContextData({ restoreScanning: phase === 'scanning' || retrying });
    return () => {
      updateContextData({ restoreScanning: false });
    };
  }, [phase, retrying, updateContextData]);

  const generateAddress = async () => {
    // Previews are re-requested on every passphrase change while older
    // derivations may still be in flight; only the newest generation may
    // publish its result.
    const generation = ++previewGeneration.current;
    const addresses: string[] = [];
    for (let i = 0; i < hdPathOptions.length; i++) {
      const options = hdPathOptions[i];
      try {
        const keyring = await wallet.createTmpKeyringWithMnemonics(
          contextData.mnemonics,
          options.hdPath,
          contextData.passphrase,
          options.addressType,
          1
        );
        if (generation !== previewGeneration.current) {
          return;
        }
        // const address = keyring.accounts[0].address;
        // addresses.push(address);
        keyring.accounts.forEach((v) => {
          addresses.push(v.address);
        });
      } catch (e) {
        console.log(e);
        if (generation !== previewGeneration.current) {
          return;
        }
        setError((e as any).message);
        return;
      }
    }
    setPreviewAddresses(addresses);
  };

  useEffect(() => {
    generateAddress();
  }, [contextData.passphrase, qbitHdPath]);

  const fetchAddressesBalance = async () => {
    if (!contextData.isRestore) {
      return;
    }

    const addresses = previewAddresses;
    if (!addresses[0]) return;

    setLoading(true);
    const balances = await wallet.getMultiAddressSummaries(addresses.join(','));
    setLoading(false);

    const addressAssets: { [key: string]: { totalAmount: string; satoshis: number } } = {};
    let maxSatoshis = 0;
    let recommended = 0;
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const balance = balances[i];
      const satoshis = balance.totalSatoshis;
      addressAssets[address] = {
        totalAmount: satoshisToAmount(balance.totalSatoshis),
        satoshis
      };
      if (satoshis > maxSatoshis) {
        maxSatoshis = satoshis;
        recommended = i;
      }
    }
    if (maxSatoshis > 0) {
      setRecommendedTypeIndex(recommended);
    }

    setAddressAssets(addressAssets);
  };

  useEffect(() => {
    fetchAddressesBalance();
  }, [previewAddresses]);

  const disabled = useMemo(() => {
    if (!error) {
      return false;
    } else {
      return true;
    }
  }, [error]);

  const onNext = async () => {
    try {
      const option = hdPathOptions[contextData.addressTypeIndex];
      if (!option) {
        throw new Error(t('not_supported'));
      }

      if (contextData.isRestore) {
        // Once a restore succeeds the keyring exists, so the orchestration
        // never re-runs from this mount; the guard clears only on failure.
        if (restoreInProgress.current) {
          return;
        }
        restoreInProgress.current = true;
        // Lock the parent's back/tab controls in the same render pass as the
        // scanning UI; leaving during the pre-effect gap would unmount this
        // step and orphan the already running restore.
        updateContextData({ restoreScanning: true });
        setPhase('scanning');
        const restoreReport = await restoreQbitWallet(
          contextData.mnemonics,
          option.hdPath,
          passphraseRef.current,
          contextData.addressType
        );
        setReport(restoreReport);
        setPhase('report');
        return;
      }

      await createAccount(
        contextData.mnemonics,
        option.hdPath,
        passphraseRef.current,
        contextData.addressType,
        1
      );
      navigate('MainScreen');
    } catch (e) {
      restoreInProgress.current = false;
      tools.toastError((e as any).message);
      setPhase('form');
    }
  };

  const refreshConcurrentHint = () => {
    wallet
      .getQbitConcurrentInstanceHint()
      .then((hint) => setConcurrentHint(hint))
      .catch(() => undefined);
  };

  useEffect(() => {
    if (phase !== 'report') {
      return;
    }
    refreshConcurrentHint();
  }, [phase, report]);

  const retryFloorScan = async () => {
    if (!report || report.floorsCompleted) {
      return;
    }
    // Same pre-effect gap as onNext: the retry re-enters the uncancellable
    // scan immediately, so the parent lock cannot wait for the mirror effect.
    updateContextData({ restoreScanning: true });
    setRetrying(true);
    try {
      const summary = await wallet.runQbitRestoreFloorScan();
      const stillPending = await wallet.getQbitRestoreFloorsPending();
      if (stillPending) {
        // The scan resolved without lifting the signing gate; keep the
        // failure card and retry affordance visible.
        tools.toastError(t('qbit_restore_floors_incomplete_warning'));
        return;
      }
      setReport({
        network: report.network,
        accountsRestored: report.accountsRestored,
        discovery: report.discovery,
        floorsCompleted: true,
        floorScan: summary
      });
    } catch (e) {
      tools.toastError((e as any).message);
    } finally {
      // A failed or partial retry may still have latched the persisted
      // two-live-wallet hint; refresh it regardless of outcome.
      refreshConcurrentHint();
      setRetrying(false);
    }
  };

  if (phase === 'scanning') {
    return (
      <Column full itemsCenter justifyCenter gap="xl" data-testid="restore-scanning">
        <Icon size={fontSizes.icon * 3} data-testid="restore-scanning-spinner">
          <LoaderCircle className="icon-spin" size="1em" />
        </Icon>
        <Text text={t('qbit_restore_scanning')} preset="sub" textCenter />
      </Column>
    );
  }

  if (phase === 'report' && report) {
    return (
      <Column data-testid="restore-report-page">
        <Text
          text={t('qbit_restore_report_title')}
          preset="title-bold"
          textCenter
          data-testid="restore-report"
        />

        <Row justifyBetween data-testid="restore-report-network-row">
          <Text text={t('qbit_restore_network')} preset="bold" />
          <Text text={formatRestoreNetwork(report.network)} data-testid="restore-report-network" />
        </Row>
        <Row justifyBetween data-testid="restore-report-accounts-row">
          <Text text={t('qbit_restore_accounts_restored')} preset="bold" />
          <Text text={`${report.accountsRestored}`} data-testid="restore-report-accounts" />
        </Row>

        <Card data-testid="restore-report-warning-counters">
          <Column gap="lg">
            <Text text={counterMinimumWarning} color="warning" />
            {counterReuseWarning && (
              <Text
                text={counterReuseWarning}
                preset="bold"
                color="warning"
                data-testid="restore-report-warning-recommendation"
              />
            )}
          </Column>
        </Card>

        {((report.floorsCompleted && report.floorScan.possibleConcurrentInstance) ||
          concurrentHint) && (
          <Card data-testid="restore-report-warning-concurrent">
            <Text text={t('qbit_restore_concurrent_instance_warning')} color="error" />
          </Card>
        )}

        {report.discovery.truncated && (
          <Text text={t('qbit_restore_scan_truncated_warning')} color="warning" data-testid="restore-report-truncated" />
        )}

        {!report.floorsCompleted && (
          <Column>
            <Card data-testid="restore-report-floors-incomplete">
              <Column>
                <Text text={t('qbit_restore_floors_incomplete_warning')} color="error" />
                <Text text={report.floorError} color="error" />
              </Column>
            </Card>
            <Button
              text={t('qbit_restore_retry_floor_scan')}
              onClick={retryFloorScan}
              disabled={retrying}
              data-testid="restore-retry-button"
            />
          </Column>
        )}

        <FooterButtonContainer>
          <Button
            text={t('continue')}
            preset="primary"
            onClick={() => navigate('MainScreen')}
            disabled={retrying}
            data-testid="restore-report-continue"
          />
        </FooterButtonContainer>
      </Column>
    );
  }

  return (
    <Column>
      <Text text={t('address_type')} preset="bold" data-testid="address-type-title" />

      {hdPathOptions.map((item, index) => {
        const address = previewAddresses[index];
        const assets = addressAssets[address] || {
          totalAmount: '--',
          satoshis: 0
        };
        const hasVault = contextData.isRestore && assets.satoshis > 0;
        if (item.usesBip44Path && !hasVault) {
          return null;
        }

        const hdPath = getAccountDerivationPath(item.hdPath, 0, false);
        return (
          <AddressTypeCard2
            key={index}
            label={`${item.label}`}
            items={[
              {
                address,
                satoshis: assets.satoshis,
                path: hdPath
              }
            ]}
            checked={index == contextData.addressTypeIndex}
            onClick={() => {
              updateContextData({
                addressTypeIndex: index,
                addressType: item.addressType
              });
            }}
            data-testid={`address-type-card-${index}`}
          />
        );
      })}

      {error && <Text text={error} color="error" />}

      <Column mt="lg">
        <Text text={t('phrase_optional')} preset="bold" />
        <Input
          placeholder={t('passphrase')}
          defaultValue={contextData.passphrase}
          onChange={(e) => {
            passphraseRef.current = e.target.value;
            updateContextData({
              passphrase: e.target.value
            });
          }}
          data-testid="passphrase-input"
        />
      </Column>

      <FooterButtonContainer>
        <Button
          text={t('continue')}
          preset="primary"
          onClick={onNext}
          disabled={disabled}
          data-testid="address-type-continue-button"
        />
      </FooterButtonContainer>

      {loading && (
        <Icon>
          <LoaderCircle className="icon-spin" size="1em" />
        </Icon>
      )}
    </Column>
  );
}
