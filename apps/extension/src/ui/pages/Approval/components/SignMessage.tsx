import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
import { ColdWalletSignMessage } from '@/ui/components/ColdWallet';
import { walletErrorMessage } from '@/ui/utils';
import { PhishingDetection } from '@/ui/components/PhishingDetection';
import { QbitRestoredFloorWarning } from '@/ui/components/QbitRestoredFloorWarning';
import WebsiteBar from '@/ui/components/WebsiteBar';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { AccountSignMethod } from '@qbit/wallet-shared';
import {
  SignMessageProps,
  useCurrentAccountCapabilities,
  useSignMessageLogic,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import MultiSignDisclaimerModal from './SignPsbt/components/MultiSignDisclaimerModal';
import { SignPsbtSection } from './SignPsbt/components/Section';
import ProviderContextCard from './ProviderContextCard';
import WebsiteCheckWarning from './WebsiteCheckWarning';

type RecoverySignFlight = { challengeId: string; handedOff: boolean };

export default function SignMessage(props: SignMessageProps) {
  const {
    loading,
    t,
    session,

    // page state
    isColdWalletSigning,
    showMultiSignView,

    disclaimerVisible,

    // data
    toSignMessages,
    currentToSignMessage,

    // state
    websiteCheckStatus,
    websiteCheckWarning: websiteCheckWarningText,
    isBlocked,
    allowQuickMultiSign,

    // multiple sign state
    isAllSigned,
    signedCount,
    multiSignList,

    // actions
    onClickBack,
    onClickSign,
    onRetryWebsiteCheck,
    onQuickMultiSign,
    onTryMultiSign,
    onTrustSite,

    onColdWalletSigningSuccess,
    onColdWalletSigningBack,

    readonlySignature,
    setReadonlySignature,

    onDisclaimerModalClose
  } = useSignMessageLogic(props);
  const accountCapabilities = useCurrentAccountCapabilities();
  const tools = useTools();
  const wallet = useWallet();
  const isReadonly = accountCapabilities.signMethod === AccountSignMethod.External;
  const [acknowledgedOrigin, setAcknowledgedOrigin] = useState('');
  const [confirmedRecoveryChallenge, setConfirmedRecoveryChallenge] = useState('');
  const [recoverySignLocked, setRecoverySignLocked] = useState(false);
  const recoverySignFlightRef = useRef<RecoverySignFlight | null>(null);
  const mountedRef = useRef(true);
  const restoredFloorRisk = currentToSignMessage?.signatureBudget?.restoredFloorRisk;
  const isUnverifiedWebsite = websiteCheckStatus === 'unverified';
  const hasAcknowledgedUnverifiedWebsite =
    isUnverifiedWebsite && !!session?.origin && acknowledgedOrigin === session.origin;
  const isUnverifiedWebsiteBlocked = isUnverifiedWebsite && !hasAcknowledgedUnverifiedWebsite;

  let header = props.header;

  if (!header && session) {
    header = (
      <Header>
        <WebsiteBar session={session} />
      </Header>
    );
  }

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
    flight.handedOff = true;
    onClickSign();
    if (accountCapabilities.signMethod !== AccountSignMethod.Local) {
      // Non-local methods return to an interactive screen (cold-wallet back,
      // readonly signature entry) without consuming the challenge, so allow
      // another confirmation pass.
      releaseRecoverySignFlight(flight);
    }
  };

  const handleBatchAction = () => {
    if (isUnverifiedWebsiteBlocked) return;
    if (allowQuickMultiSign) {
      onQuickMultiSign();
    } else {
      onTryMultiSign();
    }
  };

  const websiteCheckWarning = isUnverifiedWebsite ? (
    <WebsiteCheckWarning warning={websiteCheckWarningText} onRetry={handleRetryWebsiteCheck} testIdPrefix="message-" />
  ) : null;

  const unverifiedWebsiteConfirmation = isUnverifiedWebsite ? (
    <Checkbox
      checked={hasAcknowledgedUnverifiedWebsite}
      onChange={(event) =>
        setAcknowledgedOrigin(event.target.checked && session?.origin ? session.origin : '')
      }
      style={{ marginBottom: spacing.small }}
      data-testid="message-unverified-website-confirmation"
    >
      <Text text={t('unverified_website_confirmation')} preset="sub-bold" />
    </Checkbox>
  ) : null;

  // condition render
  if (isBlocked) {
    return <PhishingDetection handleCancel={handleClickBack} />;
  }

  // Handle cold wallet signing
  if (isColdWalletSigning && currentToSignMessage) {
    return (
      <ColdWalletSignMessage
        messages={[{ text: currentToSignMessage.text, type: currentToSignMessage.type }]}
        onSuccess={(ret) =>
          onColdWalletSigningSuccess({
            signature: ret[0]
          })
        }
        onCancel={onColdWalletSigningBack}
        header={header}
        origin={props.params.session?.origin}
      />
    );
  }

  if (loading) {
    return (
      <Layout>
        {header}
        <Content itemsCenter justifyCenter>
          <Column itemsCenter>
            <Icon size={fontSizes.xxxl} color="gold">
              <LoaderCircle className="icon-spin" size="1em" />
            </Icon>
            <Text text={t('checking_website_safety')} textCenter mt="md" />
          </Column>
        </Content>
        <Footer>
          <Row full>
            <Button
              preset="default"
              text={t('reject')}
              onClick={handleClickBack}
              full
              data-testid="message-check-loading-reject-button"
            />
          </Row>
        </Footer>
      </Layout>
    );
  }

  if (showMultiSignView) {
    return (
      <Layout>
        {header}
        <Content>
          {websiteCheckWarning}
          <Text text={t('sign_multiple_transactions')} preset="title-bold" textCenter mt="lg" />
          <Column>
            {multiSignList.map(({ title, buttonText, buttonPreset, onClick }, index) => {
              return (
                <Card key={index}>
                  <Row justifyBetween fullX>
                    <Column>
                      <Text text={`${t('message')} ${index + 1}`} preset="bold" />
                      <Text text={title} wrap />
                    </Column>
                    <Column>
                      <Button
                        preset={buttonPreset as any}
                        textStyle={{ fontSize: fontSizes.sm }}
                        text={buttonText}
                        onClick={onClick}
                        style={{ width: 80, height: 25 }}
                      />
                    </Column>
                  </Row>
                </Card>
              );
            })}
          </Column>
        </Content>

        <Footer>
          {unverifiedWebsiteConfirmation}
          <Row full>
            <Button preset="default" text={t('reject_all')} onClick={handleClickBack} full />

            <Button
              preset="primary"
              text={isAllSigned ? t('submit') : `(${signedCount}/${toSignMessages.length}) ${t('signed')}`}
              icon={isAllSigned ? undefined : 'alert'}
              onClick={handleBatchAction}
              disabled={isUnverifiedWebsiteBlocked}
              aria-disabled={isUnverifiedWebsiteBlocked}
              full
            />
          </Row>
        </Footer>
        {disclaimerVisible && (
          <MultiSignDisclaimerModal
            txCount={toSignMessages.length}
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
    isUnverifiedWebsiteBlocked ||
    recoverySignLocked ||
    Boolean(restoredFloorRisk && confirmedRecoveryChallenge !== restoredFloorRisk.challengeId);

  return (
    <Layout>
      <Content>
        <Header>
          <WebsiteBar session={session} />
        </Header>
        <Column>
          {websiteCheckWarning}
          <Text text={t('signature_request')} preset="title-bold" textCenter mt="lg" />
          <Text text={t('only_sign_this_message_if_you_fully_understand_the')} preset="sub" textCenter mt="lg" />
          <Text text={t('you_are_signing')} textCenter mt="lg" />

          <Card>
            <div
              data-testid="p2mr-message-text"
              style={{
                userSelect: 'text',
                maxHeight: 384,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                flexWrap: 'wrap',
                color: 'var(--qbit-ink)'
              }}
            >
              {currentToSignMessage.text}
            </div>
          </Card>

          {/* Provider metadata is secondary to the exact message above. */}
          <ProviderContextCard context={currentToSignMessage?.providerContext || props.params.context} />

          <Card data-testid="p2mr-message-signature-budget">
            <Column gap="sm" fullX>
              <Text text={`P2MR message proof v1`} preset="bold" />
              <Text
                text={`UTF-8 message bytes: ${new TextEncoder().encode(currentToSignMessage.text).length}`}
                color="textDim"
              />
              {currentToSignMessage.signatureBudget && (
                <>
                  <Text
                    text={`New signatures: ${currentToSignMessage.signatureBudget.required}; cached: ${currentToSignMessage.signatureBudget.cached}`}
                    color="textDim"
                  />
                  {!restoredFloorRisk && (
                    <Text
                      text={`Signature budget: ${currentToSignMessage.signatureBudget.remainingBefore} before, ${currentToSignMessage.signatureBudget.remainingAfter} after`}
                      color="textDim"
                    />
                  )}
                </>
              )}
            </Column>
          </Card>
          {restoredFloorRisk && (
            <QbitRestoredFloorWarning
              risk={restoredFloorRisk}
              checked={confirmedRecoveryChallenge === restoredFloorRisk.challengeId}
              onChange={(checked) => setConfirmedRecoveryChallenge(checked ? restoredFloorRisk.challengeId : '')}
            />
          )}
          {isReadonly && (
            <SignPsbtSection title={t('readonly_signing')}>
              <Card>
                <Column gap="sm" fullX>
                  <Text text={`1. ${t('readonly_signing_copy_step')}`} color="textDim" />

                  <Button
                    preset="defaultV2"
                    onClick={() => {
                      tools.copyToClipboard(JSON.stringify([currentToSignMessage.text, currentToSignMessage.type]));
                    }}
                    text={t('readonly_signing_copy_button')}
                  />
                </Column>
              </Card>
              <Card>
                <Column gap="sm" fullX>
                  <Text text={`2. ${t('readonly_signing_paste_signature_step')}`} color="textDim" />

                  <Input
                    preset="text"
                    placeholder={t('readonly_signing_signature_placeholder')}
                    autoFocus
                    value={readonlySignature}
                    onChange={(e) => {
                      setReadonlySignature(e.target.value.trim());
                    }}
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
            text={t('sign')}
            onClick={() => void handleClickSign()}
            disabled={signDisabled}
            aria-disabled={signDisabled}
            full
            data-testid="sign-message-button"
          />
        </Row>
      </Footer>
    </Layout>
  );
}
