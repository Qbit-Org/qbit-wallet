import { LoaderCircle } from 'lucide-react';
import { ListRef } from 'rc-virtual-list';
import { forwardRef, useEffect, useRef, useState } from 'react';

import {
  Button,
  Card,
  Checkbox,
  Column,
  Content,
  Footer,
  Header,
  Icon,
  Input,
  Layout,
  Row,
  Text
} from '@/ui/components';
import { AutoFitVirtualList } from '@/ui/components/AutoFitVirtualList';
import ColdWalletSignPsbt from '@/ui/components/ColdWallet/ColdWalletSignPsbt';
import { PhishingDetection } from '@/ui/components/PhishingDetection';
import { QbitRestoredFloorWarning } from '@/ui/components/QbitRestoredFloorWarning';
import { SignPsbtWithRisksPopover } from '@/ui/components/SignPsbtWithRisksPopover';
import WebsiteBar from '@/ui/components/WebsiteBar';
import { walletErrorMessage } from '@/ui/utils';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { numUtils } from '@qbit/base-utils';
import { AccountSignMethod, ToSignData } from '@qbit/wallet-shared';
import {
  PsbtLocalInfo,
  SignPsbtProps,
  useCurrentAccountCapabilities,
  useI18n,
  useQbitUnit,
  useSignPsbtLogic,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import ActionOverviewSection from './components/ActionOverviewSection';
import TransactionOverviewSection from './components/TransactionOverviewSection';
import { InputsList } from './components/InputsList';
import MultiSignDisclaimerModal from './components/MultiSignDisclaimerModal';
import { OutputsList } from './components/OutputsList';
import PsbtDataSection from './components/PsbtDataSection';
import { SignPsbtSection } from './components/Section';
import ProviderContextCard from '../ProviderContextCard';
import WebsiteCheckWarning from '../WebsiteCheckWarning';

const ITEM_HEIGHT = 88 + 8; // item height + margin top

type RecoverySignFlight = { challengeId: string; handedOff: boolean };

function TransactionItem(
  {
    index,
    buttonText,
    buttonPreset,
    psbtInfo,
    toSignData,
    onClick
  }: {
    index: number;
    buttonText: string;
    buttonPreset: string;
    psbtInfo?: PsbtLocalInfo;
    toSignData?: ToSignData;
    onClick: () => void;
  },
  ref: any
) {
  const { t } = useI18n();
  const qbitUnit = useQbitUnit();
  return (
    <Card style={{ height: ITEM_HEIGHT - 8, marginTop: 8 }}>
      <Row justifyBetween fullX itemsCenter>
        <Column gap="zero" style={{ flex: 1, minWidth: 0 }}>
          <Text text={`${t('transaction')} ${index + 1}`} preset="bold" />
          {psbtInfo && !psbtInfo.parseError ? (
            <Row gap="sm" itemsCenter style={{ flexWrap: 'wrap' }}>
              <Text text={`${t('inputs')}: ${psbtInfo.inputCount}`} size="xs" color="textDim" />
              <Text text={`${t('outputs')}: ${psbtInfo.outputCount}`} size="xs" color="textDim" />
              <Row>
                {psbtInfo.feeRate !== '-' && <Text text={`${psbtInfo.feeRate} bits/vB`} size="xs" color="textDim" />}
                {psbtInfo.isCompleted && psbtInfo.fee > 0 && (
                  <Text text={`${numUtils.satoshisToAmount(psbtInfo.fee)} ${qbitUnit}`} size="xs" color="textDim" />
                )}
              </Row>
              {psbtInfo.hasSighashNone && <Text text="SIGHASH_NONE" size="xs" color="dangerText" />}
              {toSignData?.signatureBudget && (
                <Text
                  text={
                    toSignData.signatureBudget.restoredFloorRisk
                      ? `${t('qbit_recovery_status_seed_only')}; ${t(
                          'qbit_known_onchain_usage_lower_bound',
                          `${toSignData.signatureBudget.restoredFloorRisk.knownOnChainSignatures}+`
                        )}`
                      : `Signatures: ${toSignData.signatureBudget.required} new, ${toSignData.signatureBudget.cached} cached; ${toSignData.signatureBudget.remainingAfter} remaining`
                  }
                  size="xs"
                  color="textDim"
                />
              )}
            </Row>
          ) : psbtInfo?.parseError ? (
            <Text text={t('parse_error')} size="xs" color="dangerText" />
          ) : null}
        </Column>
        <Button
          preset={buttonPreset as any}
          textStyle={{ fontSize: fontSizes.sm }}
          text={buttonText}
          onClick={onClick}
          style={{ width: 80, height: 25 }}
        />
      </Row>
    </Card>
  );
}

export default function SignPsbt(props: SignPsbtProps) {
  const accountCapabilities = useCurrentAccountCapabilities();
  const tools = useTools();
  const wallet = useWallet();
  const isReadonlySigning = accountCapabilities.signMethod === AccountSignMethod.External;
  const {
    showLoading,
    isPsbtRiskPopoverVisible,

    t,
    session,

    // data
    toSignDatas,
    currentToSignData,
    currentDecodedPsbt,
    readonlySignedPsbtHex,
    setReadonlySignedPsbtHex,

    // signing state
    isColdWalletSigning,
    showMultiSignView,

    disclaimerVisible,
    localPsbtSummary,

    // state
    decodeError,
    websiteCheckStatus,
    websiteCheckWarning: websiteCheckWarningText,
    isAllSigned,
    signedCount,
    multiSignList,

    isValid,
    networkFee,
    hasRisk,
    showFeeSection,
    isBlocked,
    allowQuickMultiSign,

    // actions
    onClickBack,
    onClickSign,
    onRetryDecode,
    onRetryWebsiteCheck,
    onRejectApprovalError,
    onQuickMultiSign,
    onTryMultiSign,
    onTrustSite,

    onColdWalletSigningSuccess,
    onColdWalletSigningBack,

    onRiskPopoverConfirm,
    onRiskPopoverClose,

    onDisclaimerModalClose
  } = useSignPsbtLogic(props as any);
  const isProviderBatch =
    toSignDatas.length > 1 &&
    Boolean(props.params.context || toSignDatas.some((toSignData) => toSignData.providerContext));
  let header = props.header;
  const [acknowledgedOrigin, setAcknowledgedOrigin] = useState('');
  const [confirmedRecoveryChallenge, setConfirmedRecoveryChallenge] = useState('');
  const [recoverySignLocked, setRecoverySignLocked] = useState(false);
  const recoverySignFlightRef = useRef<RecoverySignFlight | null>(null);
  const mountedRef = useRef(true);
  const restoredFloorRisk = currentToSignData?.signatureBudget?.restoredFloorRisk;
  const isUnverifiedWebsite = websiteCheckStatus === 'unverified';
  const hasAcknowledgedUnverifiedWebsite =
    isUnverifiedWebsite && !!session?.origin && acknowledgedOrigin === session.origin;
  const isUnverifiedWebsiteBlocked = isUnverifiedWebsite && !hasAcknowledgedUnverifiedWebsite;

  const isValidData = isValid && currentDecodedPsbt;

  const ForwardTransactionItem = forwardRef(TransactionItem);
  const refList = useRef<ListRef>(null);
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (refList.current && signedCount >= 1) {
        refList.current?.scrollTo({ key: 'psbt_' + (signedCount - 1), align: 'top' });
      }
    });

    return () => clearTimeout(timeoutId);
  }, [signedCount]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setAcknowledgedOrigin('');
  }, [session?.origin, websiteCheckStatus]);

  const releaseRecoverySignFlight = (flight?: RecoverySignFlight) => {
    if (flight && recoverySignFlightRef.current !== flight) return;
    recoverySignFlightRef.current = null;
    setRecoverySignLocked(false);
  };

  useEffect(() => {
    setConfirmedRecoveryChallenge('');
    releaseRecoverySignFlight();
  }, [restoredFloorRisk?.challengeId]);

  const handleRetryWebsiteCheck = () => {
    setAcknowledgedOrigin('');
    onRetryWebsiteCheck();
  };

  const handleClickBack = () => {
    const flight = recoverySignFlightRef.current;
    if (flight && !flight.handedOff) {
      // Rejecting while the confirmation round-trip is pending must not let
      // the resolved confirmation launch signing afterwards.
      releaseRecoverySignFlight(flight);
    }
    onClickBack();
  };

  const handleClickSign = async () => {
    if (isUnverifiedWebsiteBlocked) return;
    if (!restoredFloorRisk) {
      onClickSign();
      return;
    }
    const { challengeId } = restoredFloorRisk;
    if (confirmedRecoveryChallenge !== challengeId) return;
    // A second click can land before React re-renders with the button
    // disabled; without a synchronous lock it would confirm and launch
    // signing twice, and the losing attempt would fail the approval after
    // the first one already consumed the one-shot challenge.
    if (recoverySignFlightRef.current) return;
    const flight: RecoverySignFlight = { challengeId, handedOff: false };
    recoverySignFlightRef.current = flight;
    setRecoverySignLocked(true);
    try {
      await wallet.confirmQbitRestoredFloorSigning(challengeId);
    } catch (error) {
      tools.toastError(walletErrorMessage(error, t('unknown_error')));
      releaseRecoverySignFlight(flight);
      return;
    }
    if (!mountedRef.current || recoverySignFlightRef.current !== flight) return;
    if (hasRisk) {
      // Signing continues from the risks popover; keep the flight so the
      // Sign button stays locked behind it.
      onClickSign();
      return;
    }
    flight.handedOff = true;
    const signOutcome = onClickSign();
    if (accountCapabilities.signMethod !== AccountSignMethod.Local) {
      // Non-local methods return to an interactive screen (cold-wallet back,
      // readonly signature entry) without consuming the challenge, so allow
      // another confirmation pass.
      releaseRecoverySignFlight(flight);
      return;
    }
    if ((await signOutcome) === false) {
      // Local signing failed and left the approval open without consuming
      // the challenge, so re-arm the Sign button for a retry.
      releaseRecoverySignFlight(flight);
    }
  };

  const handleRiskPopoverClose = () => {
    const flight = recoverySignFlightRef.current;
    if (flight && !flight.handedOff) {
      // Closing the risk review abandons the handoff; the challenge is still
      // valid, so re-arm the Sign button for another pass.
      releaseRecoverySignFlight(flight);
    }
    onRiskPopoverClose();
  };

  const handleRiskPopoverConfirm = async () => {
    if (isUnverifiedWebsiteBlocked) {
      handleRiskPopoverClose();
      return;
    }
    if (restoredFloorRisk) {
      const flight = recoverySignFlightRef.current;
      if (!flight || flight.challengeId !== restoredFloorRisk.challengeId) {
        // The challenge changed while the popover was open; drop the stale
        // handoff instead of signing without a matching confirmation.
        handleRiskPopoverClose();
        return;
      }
      // The popover hands off to signing exactly once; a duplicate click
      // before React removes it must not launch a second attempt.
      if (flight.handedOff) return;
      flight.handedOff = true;
      const signOutcome = onRiskPopoverConfirm();
      if (accountCapabilities.signMethod !== AccountSignMethod.Local) {
        releaseRecoverySignFlight(flight);
        return;
      }
      if ((await signOutcome) === false) {
        // Local signing failed and left the approval open without consuming
        // the challenge, so re-arm the Sign button for a retry.
        releaseRecoverySignFlight(flight);
      }
      return;
    }
    onRiskPopoverConfirm();
  };

  const handleTryMultiSign = () => {
    if (isUnverifiedWebsiteBlocked) return;
    if (allowQuickMultiSign) {
      onQuickMultiSign();
    } else {
      onTryMultiSign();
    }
  };

  const websiteCheckWarning = isUnverifiedWebsite ? (
    <WebsiteCheckWarning warning={websiteCheckWarningText} onRetry={handleRetryWebsiteCheck} testIdPrefix="psbt-" />
  ) : null;

  const unverifiedWebsiteConfirmation = isUnverifiedWebsite ? (
    <Checkbox
      checked={hasAcknowledgedUnverifiedWebsite}
      onChange={(event) => setAcknowledgedOrigin(event.target.checked && session?.origin ? session.origin : '')}
      style={{ marginBottom: spacing.small }}
      data-testid="psbt-unverified-website-confirmation"
    >
      <Text text={t('unverified_website_confirmation')} preset="sub-bold" />
    </Checkbox>
  ) : null;

  if (!header && session) {
    header = (
      <Header>
        <WebsiteBar session={session} />
      </Header>
    );
  }

  // condition render
  if (isBlocked) {
    return <PhishingDetection handleCancel={handleClickBack} />;
  }

  if (decodeError) {
    return (
      <Layout>
        {header}
        <Content>
          <Column>
            <Text text={t('warning')} preset="title-bold" textCenter mt="xxl" />
            <Text text={t('failed_to_parse_psbt')} textCenter mt="md" data-testid="psbt-decode-error" />
          </Column>
        </Content>
        <Footer>
          <Row full>
            <Button
              preset="default"
              text={t('reject')}
              onClick={onRejectApprovalError}
              full
              data-testid="psbt-error-reject-button"
            />
            <Button
              preset="primary"
              text={t('try_again')}
              onClick={onRetryDecode}
              full
              data-testid="psbt-error-retry-button"
            />
          </Row>
        </Footer>
      </Layout>
    );
  }

  // cold-wallet signing
  if (isColdWalletSigning && currentToSignData) {
    return (
      <ColdWalletSignPsbt
        psbtHex={currentToSignData.psbtHex}
        onSuccess={onColdWalletSigningSuccess}
        onCancel={onColdWalletSigningBack}
        header={header}
      />
    );
  }

  if (showLoading) {
    return (
      <Layout>
        {header}
        <Content itemsCenter justifyCenter>
          <Column itemsCenter>
            <Icon size={fontSizes.xxxl} color="gold">
              <LoaderCircle className="icon-spin" size="1em" />
            </Icon>
            <Text
              text={websiteCheckStatus === 'checking' ? t('checking_website_safety') : t('loading')}
              textCenter
              mt="md"
            />
          </Column>
        </Content>
        <Footer>
          <Row full>
            <Button
              preset="default"
              text={t('reject')}
              onClick={handleClickBack}
              full
              data-testid="psbt-loading-reject-button"
            />
          </Row>
        </Footer>
      </Layout>
    );
  }

  if (showMultiSignView) {
    const hasSighashNoneRisk = localPsbtSummary?.hasSighashNone;
    const hasParseError = localPsbtSummary && localPsbtSummary.parseErrorCount > 0;

    return (
      <Layout>
        {header}
        <Content>
          {websiteCheckWarning}
          <Text text={t('sign_multiple_transactions')} preset="title-bold" textCenter mt="lg" />
          {isProviderBatch && (
            <Text
              text="Review and sign each transaction individually. Qbit provider batches cannot be quick-signed."
              color="textDim"
              textCenter
              data-testid="qbit-provider-batch-review-required"
            />
          )}

          {localPsbtSummary && (
            <Card
              style={{
                marginTop: 8,
                padding: '8px 12px',
                borderColor: hasSighashNoneRisk || hasParseError ? '#ff4d4f' : colors.border,
                borderWidth: 1,
                background: colors.surface
              }}
            >
              <Row justifyBetween fullX>
                <Column>
                  <Text text={`${t('transaction_count')}: ${toSignDatas.length}`} size="xs" color="textDim" />
                </Column>
                {(hasSighashNoneRisk || hasParseError) && (
                  <Text
                    text={hasSighashNoneRisk ? `🚫 SIGHASH_NONE` : `🚫 ${t('parse_error')}`}
                    size="xs"
                    color="dangerText"
                  />
                )}
              </Row>
            </Card>
          )}

          <AutoFitVirtualList
            data={multiSignList}
            itemHeight={ITEM_HEIGHT}
            itemKey={(item) => 'psbt_' + item.index}
            listRef={refList}
          >
            {(item, index) => (
              <ForwardTransactionItem
                buttonText={item.buttonText}
                buttonPreset={item.buttonPreset}
                psbtInfo={item.psbtInfo}
                toSignData={toSignDatas[index]}
                onClick={item.onClick}
                index={index}
              />
            )}
          </AutoFitVirtualList>

          {/* Provider metadata follows the batch summary and the transaction list. */}
          <ProviderContextCard context={props.params.context || toSignDatas[0]?.providerContext} />
        </Content>

        <Footer>
          {unverifiedWebsiteConfirmation}
          <Row full>
            <Button preset="default" text={t('reject_all')} onClick={handleClickBack} full />

            {!isProviderBatch && (
              <Button
                preset="primary"
                text={isAllSigned ? t('submit') : `(${signedCount}/${toSignDatas.length}) ${t('signed')}`}
                onClick={handleTryMultiSign}
                icon={allowQuickMultiSign ? undefined : 'alert'}
                disabled={isUnverifiedWebsiteBlocked}
                aria-disabled={isUnverifiedWebsiteBlocked}
                full
              />
            )}
          </Row>
        </Footer>

        {disclaimerVisible && !isProviderBatch && (
          <MultiSignDisclaimerModal
            txCount={toSignDatas.length}
            onContinue={(trustSite) => {
              if (isUnverifiedWebsiteBlocked) return;
              if (trustSite) onTrustSite();
              onQuickMultiSign();
            }}
            onClose={onDisclaimerModalClose}
          />
        )}
      </Layout>
    );
  }

  const signDisabled =
    !isValid ||
    isUnverifiedWebsiteBlocked ||
    recoverySignLocked ||
    Boolean(restoredFloorRisk && confirmedRecoveryChallenge !== restoredFloorRisk.challengeId);

  return (
    <Layout>
      {header}
      <Content>
        <Column gap="xl">
          {websiteCheckWarning}
          {/* The action being authorized precedes secondary provider metadata. */}
          <ActionOverviewSection decodedPsbt={currentDecodedPsbt} action={currentToSignData.action!} />
          <ProviderContextCard context={props.params.context || currentToSignData.providerContext} />

          {restoredFloorRisk && (
            <QbitRestoredFloorWarning
              risk={restoredFloorRisk}
              checked={confirmedRecoveryChallenge === restoredFloorRisk.challengeId}
              onChange={(checked) => setConfirmedRecoveryChallenge(checked ? restoredFloorRisk.challengeId : '')}
            />
          )}
          <SignPsbtSection title={t('transaction_details')}>
            {isValidData && (
              <Column gap="md" mt="zero">
                <InputsList
                  decodedPsbt={currentDecodedPsbt}
                  toSignData={currentToSignData}
                />

                <OutputsList decodedPsbt={currentDecodedPsbt} />
              </Column>
            )}
          </SignPsbtSection>

          <TransactionOverviewSection
            decodedPsbt={currentDecodedPsbt}
            networkFee={networkFee}
            toSignData={currentToSignData}
          />

          {/* PSBT data */}
          <PsbtDataSection toSignData={currentToSignData} />

          {isReadonlySigning && (
            <SignPsbtSection title={t('readonly_signing')}>
              <Card>
                <Column gap="sm" fullX>
                  <Text text={`1. ${t('readonly_signing_copy_step')}`} color="textDim" />

                  <Button
                    preset="defaultV2"
                    onClick={() => {
                      tools.copyToClipboard(
                        JSON.stringify([
                          currentToSignData.psbtHex,
                          {
                            autoFinalized: currentToSignData.autoFinalized !== false,
                            toSignInputs: currentToSignData.toSignInputs
                          }
                        ])
                      );
                    }}
                    text={t('readonly_signing_copy_button')}
                  />
                </Column>
              </Card>
              <Card>
                <Column gap="sm" fullX>
                  <Text text={`2. ${t('readonly_signing_paste_step')}`} color="textDim" />
                  <Input
                    preset="text"
                    placeholder={t('readonly_signing_paste_placeholder')}
                    value={readonlySignedPsbtHex}
                    onChange={(e) => {
                      setReadonlySignedPsbtHex(e.target.value.trim());
                    }}
                    data-testid="readonly-signed-psbt-input"
                  />
                </Column>
              </Card>
            </SignPsbtSection>
          )}
        </Column>
      </Content>

      {/* footer buttons */}
      <Footer>
        {unverifiedWebsiteConfirmation}
        <Row full>
          <Button preset="default" text={t('reject')} onClick={handleClickBack} full />
          <Button
            preset="primary"
            icon={hasRisk ? 'risk' : undefined}
            text={t('sign')}
            onClick={() => void handleClickSign()}
            disabled={signDisabled}
            aria-disabled={signDisabled}
            full
            data-testid="sign-psbt-button"
          />
        </Row>
      </Footer>

      {/* popup component */}
      {isPsbtRiskPopoverVisible && (
        <SignPsbtWithRisksPopover
          decodedPsbt={currentDecodedPsbt}
          onClose={handleRiskPopoverClose}
          onConfirm={handleRiskPopoverConfirm}
        />
      )}

    </Layout>
  );
}
