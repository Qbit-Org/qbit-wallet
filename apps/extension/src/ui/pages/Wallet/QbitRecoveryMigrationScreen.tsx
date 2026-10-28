import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Button, Card, Checkbox, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { Popover } from '@/ui/components/Popover';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { copyToClipboard, shortAddress } from '@/ui/utils';
import { Step1_Confirm } from '@/ui/pages/Account/createHDWalletComponents/Step1_Confirm';
import { Step1_Create } from '@/ui/pages/Account/createHDWalletComponents/Step1_Create';
import { ContextData, TabType, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { useWalletKeepalive } from '@/ui/utils/hooks';
import { numUtils } from '@qbit/base-utils';
import { ErrorCodes, PlatformEnv, QbitRecoveryState, ToSignData, WordsType } from '@qbit/wallet-shared';
import { useChainType, useI18n, useQbitUnit, useTools, useWallet } from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';

import { useNavigate } from '../MainRoute';
import {
  QbitRecoveryErrorReport,
  QbitRecoveryErrorStep,
  buildQbitRecoveryErrorReport,
  formatQbitRecoveryErrorReport
} from './qbitRecoveryErrorReport';

type MigrationStage = 'loading' | 'seed' | 'review' | 'pending' | 'complete' | 'error';

// Errors cross the background→UI port as plain { message, code?, data? }
// objects, so the stable code is the only safe way to recognize a condition.
function isProtectedAssetMigrationError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS
  );
}

// The review shows truncated destinations, yet the confirmation checkbox
// attests to a full-address check, so each row carries reveal and copy
// actions that expose the exact value before signing.
function ReviewAddressActions({
  address,
  onReveal,
  onCopy
}: {
  address: string;
  onReveal: (address: string) => void;
  onCopy: (address: string) => void;
}) {
  return (
    <Row itemsCenter gap="sm">
      <Text text={shortAddress(address, 6)} preset="bold" color="green" />
      <Icon icon="eye" color="green" onClick={() => onReveal(address)} data-testid="qbit-recovery-reveal-address" />
      <Icon icon="copy" color="green" onClick={() => onCopy(address)} data-testid="qbit-recovery-copy-address" />
    </Row>
  );
}

function isMigrationDestinationUnavailableError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ErrorCodes.QBIT_RECOVERY_DESTINATION_UNAVAILABLE
  );
}

export default function QbitRecoveryMigrationScreen() {
  const { state: routeState } = useLocation();
  const sourceKeyringIndex = (routeState as { sourceKeyringIndex?: number } | null)?.sourceKeyringIndex;
  // Keyring removal compacts indexes while this screen stays mounted, so the
  // route also carries the source anchor pubkey and every wallet call resolves
  // the current index from it when the queued operation starts.
  const sourceAnchorPubkey = (routeState as { sourceAnchorPubkey?: string } | null)?.sourceAnchorPubkey;
  const navigate = useNavigate();
  const wallet = useWallet();
  // This route displays the freshly generated destination mnemonic, so the
  // keepalive must stop after its grace period instead of holding the wallet
  // unlocked for as long as an unattended side panel stays on the screen.
  useWalletKeepalive(wallet);
  const tools = useTools();
  const { t } = useI18n();
  const qbitUnit = useQbitUnit();
  const chainType = useChainType();
  const [stage, setStage] = useState<MigrationStage>('loading');
  const [recoveryState, setRecoveryState] = useState<QbitRecoveryState>();
  const [toSignDatas, setToSignDatas] = useState<ToSignData[]>([]);
  const [reviewAccepted, setReviewAccepted] = useState(false);
  const [revealedAddress, setRevealedAddress] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [errorReport, setErrorReport] = useState<QbitRecoveryErrorReport>();
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [showRestartWarning, setShowRestartWarning] = useState(false);
  const creatingDestination = useRef(false);
  const signingInFlight = useRef(false);

  // Every failure shares one localized message, so the details panel carries
  // the failed step and the background's wording for support.
  const showError = useCallback(
    (step: QbitRecoveryErrorStep, error: unknown, message: string) => {
      const report = buildQbitRecoveryErrorReport(step, error, {
        network: chainType,
        version: PlatformEnv.VERSION
      });
      console.error(formatQbitRecoveryErrorReport(report));
      setErrorReport(report);
      setShowErrorDetails(false);
      setErrorMessage(message);
      setStage('error');
    },
    [chainType]
  );
  const [contextData, setContextData] = useState<ContextData>({
    mnemonics: '',
    hdPath: '',
    passphrase: '',
    addressType: AddressType.P2MR,
    step1CreateWordsCompleted: false,
    tabType: TabType.CREATE_WORDS,
    isRestore: false,
    isCustom: false,
    customHdPath: '',
    addressTypeIndex: 0,
    wordsType: WordsType.WORDS_24
  });

  const updateContextData = useCallback((params: UpdateContextDataParams) => {
    setContextData((previous) => ({ ...previous, ...params }));
  }, []);

  // Preparation retains one restored-floor challenge per reviewed plan (up to
  // 64 of the global 128 capacity). Leaving review without signing would pin
  // them for their full five-minute TTL and could starve every other
  // restored-floor preflight, so whatever a replaced or unmounted review no
  // longer holds is released. Re-prepares reuse the same challenge ids and
  // releasing a consumed id is a no-op, so signing and resuming are
  // unaffected.
  const heldChallengeIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const currentIds = toSignDatas
      .map((toSignData) => toSignData.signatureBudget?.restoredFloorRisk?.challengeId)
      .filter((challengeId): challengeId is string => typeof challengeId === 'string');
    const releasedIds = heldChallengeIdsRef.current.filter((challengeId) => !currentIds.includes(challengeId));
    heldChallengeIdsRef.current = currentIds;
    if (releasedIds.length > 0) {
      void Promise.resolve(wallet.releaseQbitRestoredFloorSigningChallenges(releasedIds)).catch(() => undefined);
    }
  }, [toSignDatas, wallet]);
  useEffect(
    () => () => {
      const heldIds = heldChallengeIdsRef.current;
      heldChallengeIdsRef.current = [];
      if (heldIds.length > 0) {
        void Promise.resolve(wallet.releaseQbitRestoredFloorSigningChallenges(heldIds)).catch(() => undefined);
      }
    },
    [wallet]
  );

  const resumeMigration = useCallback(async () => {
    if (!Number.isSafeInteger(sourceKeyringIndex) || sourceKeyringIndex! < 0) {
      showError('source', new Error('Source wallet index is missing'), t('qbit_recovery_source_unavailable'));
      return;
    }
    setStage('loading');
    setErrorMessage('');
    setErrorReport(undefined);
    setReviewAccepted(false);
    let step: QbitRecoveryErrorStep = 'advance';
    try {
      const advanced = await wallet.advanceQbitRecoveryMigration(sourceKeyringIndex!, sourceAnchorPubkey);
      setRecoveryState(advanced);
      if (advanced.status === 'migrated') {
        setToSignDatas([]);
        setStage('complete');
        return;
      }
      step = 'prepare';
      const prepared = await wallet.prepareQbitRecoveryMigration(sourceKeyringIndex!, undefined, sourceAnchorPubkey);
      setRecoveryState(prepared.state);
      setToSignDatas(prepared.toSignDatas);
      if (prepared.state.status === 'migrated') {
        setStage('complete');
      } else if (prepared.toSignDatas.length > 0) {
        setStage('review');
      } else {
        setStage('pending');
      }
    } catch (error) {
      showError(
        step,
        error,
        isProtectedAssetMigrationError(error)
          ? t('qbit_recovery_protected_assets_error')
          : t('qbit_recovery_error_body')
      );
    }
  }, [showError, sourceAnchorPubkey, sourceKeyringIndex, t, wallet]);

  // Run the initial load once per source keyring index. The effect's
  // dependencies churn with every provider render (t is recreated there), and
  // re-firing it would issue another advance/prepare round and kick the user
  // from review back to loading.
  const initialLoadIndexRef = useRef<number | null | undefined>(null);
  useEffect(() => {
    if (initialLoadIndexRef.current === sourceKeyringIndex) return;
    initialLoadIndexRef.current = sourceKeyringIndex;
    const load = async () => {
      if (!Number.isSafeInteger(sourceKeyringIndex) || sourceKeyringIndex! < 0) {
        showError('source', new Error('Source wallet index is missing'), t('qbit_recovery_source_unavailable'));
        return;
      }
      let step: QbitRecoveryErrorStep = 'load';
      try {
        const current = await wallet.getQbitRecoveryState(sourceKeyringIndex, sourceAnchorPubkey);
        setRecoveryState(current);
        if (current.status === 'seed-only-restored') {
          if (current.migrationDestinationReusable) {
            // A prior network's migration already created the fresh
            // destination wallet; sweep to it instead of minting another
            // seed, skipping the backup/confirm flow entirely.
            let destinationUnavailable = false;
            step = 'begin';
            try {
              await wallet.beginQbitRecoveryMigrationToExistingDestination({
                sourceKeyringIndex: sourceKeyringIndex!,
                sourceAnchorPubkey
              });
            } catch (error) {
              // Only the deliberate destination-unavailable signal may fall
              // back to minting a fresh seed. Any other begin failure can
              // leave the source durably migrating, and a seed backed up
              // after that could never become the destination, so it
              // surfaces as a retryable error instead.
              if (!isMigrationDestinationUnavailableError(error)) throw error;
              destinationUnavailable = true;
            }
            if (!destinationUnavailable) {
              await resumeMigration();
              return;
            }
          }
          setStage('seed');
        } else {
          await resumeMigration();
        }
      } catch (error) {
        showError(step, error, t('qbit_recovery_error_body'));
      }
    };
    void load();
  }, [resumeMigration, showError, sourceAnchorPubkey, sourceKeyringIndex, t, wallet]);

  useEffect(() => {
    if (
      stage !== 'seed' ||
      contextData.tabType !== TabType.CHOOSE_ADDRESS_TYPE ||
      !contextData.step1CreateWordsCompleted ||
      creatingDestination.current
    ) {
      return;
    }
    creatingDestination.current = true;
    const create = async () => {
      setStage('loading');
      try {
        await wallet.createQbitRecoveryMigrationWallet({
          sourceKeyringIndex: sourceKeyringIndex!,
          sourceAnchorPubkey,
          mnemonic: contextData.mnemonics,
          hdPath: '',
          passphrase: ''
        });
        setContextData((previous) => ({ ...previous, mnemonics: '' }));
        await resumeMigration();
      } catch {
        setContextData((previous) => ({ ...previous, mnemonics: '' }));
        try {
          const current = await wallet.getQbitRecoveryState(sourceKeyringIndex!, sourceAnchorPubkey);
          if (current.status === 'migrating' || current.status === 'migrated') {
            setRecoveryState(current);
            await resumeMigration();
            return;
          }
        } catch (error) {
          tools.toastError(t('qbit_recovery_error_body'));
          showError('create', error, t('qbit_recovery_error_body'));
          return;
        }
        setContextData((previous) => ({
          ...previous,
          step1CreateWordsCompleted: false,
          tabType: TabType.CREATE_WORDS
        }));
        tools.toastError(t('qbit_recovery_error_body'));
        setStage('seed');
      } finally {
        creatingDestination.current = false;
      }
    };
    void create();
  }, [
    contextData.mnemonics,
    contextData.step1CreateWordsCompleted,
    contextData.tabType,
    resumeMigration,
    showError,
    sourceAnchorPubkey,
    sourceKeyringIndex,
    stage,
    t,
    tools,
    wallet
  ]);

  const signAndMove = async () => {
    if (!reviewAccepted || toSignDatas.length === 0) return;
    // A second click can land before React re-renders into the loading stage;
    // without a synchronous lock it would start another confirm/sign loop
    // against the same plans, and the losing attempt would toast a migration
    // error even though the first one succeeded.
    if (signingInFlight.current) return;
    signingInFlight.current = true;
    setStage('loading');
    try {
      for (const toSignData of toSignDatas) {
        const risk = toSignData.signatureBudget?.restoredFloorRisk;
        if (!risk) {
          throw new Error(t('qbit_recovery_confirmation_unavailable'));
        }
        await wallet.confirmQbitRestoredFloorSigning(risk.challengeId);
        await wallet.signPsbtV2(toSignData);
      }
      await resumeMigration();
    } catch {
      tools.toastError(t('qbit_recovery_error_body'));
      await resumeMigration();
    } finally {
      signingInFlight.current = false;
    }
  };

  const plans = recoveryState?.migration?.plans || [];
  const reviewedPlanIds = new Set(toSignDatas.map((toSignData) => toSignData.qbitRecoveryMigration?.planId));
  const reviewedPlans = plans.filter((plan) => reviewedPlanIds.has(plan.id));
  const totalAmount = reviewedPlans.reduce((sum, plan) => sum + plan.amount, 0);
  const totalFee = reviewedPlans.reduce((sum, plan) => sum + plan.fee, 0);
  // A source holding more outputs than one transaction can spend is swept by
  // several plans to the same account; review each mapping once.
  const reviewedMappings = reviewedPlans.filter(
    (plan, index) =>
      reviewedPlans.findIndex(
        (other) => other.sourceAddress === plan.sourceAddress && other.destinationAddress === plan.destinationAddress
      ) === index
  );
  const reviewedKnownOnChainSignatures = Math.max(
    recoveryState?.knownOnChainSignatures ?? 0,
    ...toSignDatas.map((toSignData) => toSignData.signatureBudget?.restoredFloorRisk?.knownOnChainSignatures ?? 0)
  );

  const copyAddress = (address: string) => {
    void copyToClipboard(address).then(() => {
      tools.toastSuccess(t('copied'));
    });
  };

  let body;
  if (stage === 'seed') {
    body =
      contextData.tabType === TabType.VERIFY_WORDS ? (
        <Step1_Confirm contextData={contextData} updateContextData={updateContextData} />
      ) : contextData.tabType === TabType.CREATE_WORDS ? (
        <Step1_Create contextData={contextData} updateContextData={updateContextData} />
      ) : (
        <Column gap="lg" itemsCenter data-testid="qbit-recovery-loading">
          <Text text={t('qbit_recovery_loading')} />
        </Column>
      );
  } else if (stage === 'review') {
    body = (
      <Column gap="lg">
        <Text text={t('qbit_recovery_review_title')} preset="title-bold" textCenter />
        <Column
          style={{
            backgroundColor: colors.warning_bg,
            border: `1px solid ${colors.warning_content}`,
            padding: spacing.medium
          }}
          data-testid="qbit-recovery-review-intro"
        >
          <Text text={t('qbit_recovery_review_intro')} textCenter wrap />
        </Column>
        <Text
          text={
            reviewedKnownOnChainSignatures === 0
              ? t('qbit_known_onchain_usage_none')
              : t('qbit_known_onchain_usage_lower_bound', `${reviewedKnownOnChainSignatures}+`)
          }
          textCenter
          data-testid="qbit-recovery-known-onchain-usage"
        />
        <Card>
          <Column gap="sm" fullX>
            {reviewedPlans.some((plan) => plan.destinationIndex !== undefined) ? (
              // Structure-preserving sweep: the user reviews the exact
              // account-to-account mapping, not one shared destination.
              reviewedMappings.map((plan) => (
                <Row key={plan.id} justifyBetween itemsCenter gap="sm" fullX data-testid="qbit-recovery-account-mapping">
                  <Text
                    text={t('qbit_recovery_account_mapping_label', [
                      ((plan.sourceIndex ?? 0) + 1).toString(),
                      ((plan.destinationIndex ?? 0) + 1).toString()
                    ])}
                  />
                  <ReviewAddressActions
                    address={plan.destinationAddress}
                    onReveal={setRevealedAddress}
                    onCopy={copyAddress}
                  />
                </Row>
              ))
            ) : (
              <Row justifyBetween itemsCenter gap="sm" fullX data-testid="qbit-recovery-destination">
                <Text text={t('qbit_recovery_destination_label')} />
                <ReviewAddressActions
                  address={recoveryState?.migration?.destinationAddress || ''}
                  onReveal={setRevealedAddress}
                  onCopy={copyAddress}
                />
              </Row>
            )}
            <Row justifyBetween itemsCenter gap="sm" fullX data-testid="qbit-recovery-amount">
              <Text text={t('qbit_recovery_amount_label')} />
              <Text
                text={`${numUtils.satoshisToAmount(totalAmount).toString()} ${qbitUnit}`}
                preset="bold"
                color="green"
              />
            </Row>
            <Row justifyBetween itemsCenter gap="sm" fullX data-testid="qbit-recovery-fee">
              <Text text={t('qbit_recovery_fee_label')} />
              <Text
                text={`${numUtils.satoshisToAmount(totalFee).toString()} ${qbitUnit}`}
                preset="bold"
                color="green"
              />
            </Row>
          </Column>
        </Card>
        <Text
          text={t('qbit_recovery_migration_consequence')}
          preset="bold"
          textCenter
          color="warning"
          data-testid="qbit-recovery-consequence"
        />
        <Checkbox
          checked={reviewAccepted}
          onChange={(event) => setReviewAccepted(event.target.checked)}
          data-testid="qbit-recovery-review-confirmation"
        >
          <Text text={t('qbit_recovery_migration_confirmation')} preset="bold" />
        </Checkbox>
        {revealedAddress ? (
          <Popover onClose={() => setRevealedAddress('')} data-testid="qbit-recovery-address-popover">
            <Column gap="md" itemsCenter fullX>
              <Text text={t('address')} preset="bold" textCenter />
              <Text text={revealedAddress} wrap selectText textCenter data-testid="qbit-recovery-full-address" />
              <Row gap="md" itemsCenter>
                <Button
                  preset="primary"
                  text={t('copy_address')}
                  onClick={() => copyAddress(revealedAddress)}
                  data-testid="qbit-recovery-copy-full-address"
                />
                <Button
                  preset="default"
                  text={t('close')}
                  onClick={() => setRevealedAddress('')}
                  data-testid="qbit-recovery-close-address-popover"
                />
              </Row>
            </Column>
          </Popover>
        ) : null}
      </Column>
    );
  } else if (stage === 'pending') {
    body = (
      <Column gap="lg">
        <Text text={t('qbit_recovery_pending_title')} preset="title-bold" textCenter />
        <Text text={t('qbit_recovery_pending_body')} color="textDim" />
        {plans.map((plan) => (
          <Card key={plan.id}>
            <Column gap="sm" fullX>
              <Text text={plan.sourceAddress} wrap selectText />
              <Text text={t(`qbit_recovery_plan_${plan.status}`)} />
              {plan.txid ? <Text text={plan.txid} wrap selectText /> : null}
            </Column>
          </Card>
        ))}
      </Column>
    );
  } else if (stage === 'complete') {
    const destinationAddress = recoveryState?.migration?.destinationAddress || '';
    const sourceAddresses = [...new Set(plans.map((plan) => plan.sourceAddress))];
    // Structure-preserving sweeps land each source account's funds on its own
    // destination account, so completion lists every funded mapping. The
    // index-0 anchor alone may have received nothing and would present an
    // address none of the migrated funds reached.
    const mappedPlans = plans
      .filter((plan) => plan.destinationIndex !== undefined)
      .sort((a, b) => (a.destinationIndex ?? 0) - (b.destinationIndex ?? 0));
    const completedDestinations =
      mappedPlans.length > 0
        ? mappedPlans
            .filter(
              (plan, index) =>
                mappedPlans.findIndex(
                  (candidate) => candidate.destinationAddress === plan.destinationAddress
                ) === index
            )
            .map((plan) => ({
              key: plan.id,
              label: t('qbit_recovery_account_mapping', [
                ((plan.sourceIndex ?? 0) + 1).toString(),
                ((plan.destinationIndex ?? 0) + 1).toString(),
                plan.destinationAddress
              ]),
              address: plan.destinationAddress
            }))
        : [{ key: destinationAddress, label: destinationAddress, address: destinationAddress }];
    body = (
      <Column gap="lg" data-testid="qbit-recovery-complete">
        <Text text={t('qbit_recovery_complete_title')} preset="title-bold" textCenter />
        <Text text={t('qbit_recovery_complete_body')} />
        <Card>
          <Column gap="md" fullX>
            {sourceAddresses.length > 0 ? (
              <Column gap="xs" fullX>
                <Text text={t('qbit_recovery_original_address_label')} preset="sub" />
                {sourceAddresses.map((address) => (
                  <Text key={address} text={address} color="textDim" wrap selectText />
                ))}
              </Column>
            ) : null}
            <Column gap="xs" fullX>
              <Text text={t('qbit_recovery_new_address_label')} preset="sub" />
              {completedDestinations.map((destination) => (
                <Row justifyBetween itemsCenter gap="sm" fullX key={destination.key}>
                  <Text
                    text={destination.label}
                    preset="bold"
                    color="green"
                    wrap
                    selectText
                    data-testid="qbit-recovery-complete-destination"
                  />
                  <Icon
                    icon="copy"
                    color="textDim"
                    onClick={() => {
                      void copyToClipboard(destination.address).then(() => {
                        tools.toastSuccess(t('copied'));
                      });
                    }}
                    data-testid="qbit-recovery-copy-destination"
                  />
                </Row>
              ))}
            </Column>
          </Column>
        </Card>
        <Text text={t('qbit_recovery_complete_archived_body')} color="textDim" />
        <Text text={t('qbit_recovery_complete_switch_wallet_hint')} color="textDim" />
      </Column>
    );
  } else if (stage === 'error') {
    body = (
      <Column gap="lg" data-testid="qbit-recovery-error">
        <Text text={t('qbit_recovery_error_title')} preset="title-bold" color="error" />
        <Text text={errorMessage} wrap />
        {errorReport && (
          <Column gap="sm">
            <Text
              text={`${t('qbit_recovery_error_code_label')} ${errorReport.code}`}
              color="textDim"
              selectText
              data-testid="qbit-recovery-error-code"
            />
            <Row
              itemsCenter
              gap="sm"
              clickable
              onClick={() => setShowErrorDetails((shown) => !shown)}
              data-testid="qbit-recovery-error-details-toggle">
              <Text
                text={t(showErrorDetails ? 'qbit_recovery_error_hide_details' : 'qbit_recovery_error_show_details')}
                color="green"
              />
              <Icon icon={showErrorDetails ? 'up' : 'down'} color="green" />
            </Row>
            {showErrorDetails && (
              <Card>
                <Column gap="md" fullX>
                  <Text
                    text={formatQbitRecoveryErrorReport(errorReport)}
                    size="xs"
                    color="textDim"
                    wrap
                    selectText
                    style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}
                    data-testid="qbit-recovery-error-details"
                  />
                  <Button
                    preset="default"
                    text={t('qbit_recovery_error_copy_details')}
                    onClick={() => {
                      void copyToClipboard(formatQbitRecoveryErrorReport(errorReport)).then(() => {
                        tools.toastSuccess(t('copied'));
                      });
                    }}
                    data-testid="qbit-recovery-error-copy-details"
                  />
                </Column>
              </Card>
            )}
          </Column>
        )}
      </Column>
    );
  } else {
    body = (
      <Column gap="lg" itemsCenter data-testid="qbit-recovery-loading">
        <Text text={t('qbit_recovery_loading')} />
      </Column>
    );
  }

  const onHeaderBack = () => {
    // Backing out of verification returns to the seed display instead of
    // leaving the flow: the wizard context still holds the generated phrase,
    // so the user reviews the exact seed they are being quizzed on rather
    // than silently receiving a fresh one after re-entering the flow.
    if (stage === 'seed' && contextData.tabType === TabType.VERIFY_WORDS) {
      updateContextData({ tabType: TabType.CREATE_WORDS });
      return;
    }
    // Leaving the seed display discards the shown phrase — re-entering the
    // flow generates a different one — so the exit needs explicit
    // confirmation.
    if (stage === 'seed' && contextData.tabType === TabType.CREATE_WORDS) {
      setShowRestartWarning(true);
      return;
    }
    navigate('#back');
  };

  return (
    <Layout>
      <Header onBack={onHeaderBack} title={t('qbit_recovery_move_funds')} />
      <Content>{body}</Content>
      {stage === 'review' ? (
        <Footer>
          <Row full>
            <Button preset="default" text={t('back')} onClick={() => navigate('#back')} full />
            <Button
              preset="primary"
              text={t('qbit_recovery_sign_and_move')}
              disabled={!reviewAccepted}
              onClick={() => void signAndMove()}
              full
              data-testid="qbit-recovery-sign-button"
            />
          </Row>
        </Footer>
      ) : stage === 'pending' || stage === 'error' ? (
        <Footer>
          <Button
            preset="primary"
            text={t('qbit_recovery_check_status')}
            onClick={() => void resumeMigration()}
            full
            data-testid="qbit-recovery-check-status-button"
          />
        </Footer>
      ) : stage === 'complete' ? (
        <Footer>
          <Button
            preset="primary"
            text={t('qbit_recovery_return_home')}
            onClick={() => navigate('MainScreen')}
            full
            data-testid="qbit-recovery-return-home-button"
          />
        </Footer>
      ) : null}
      {showRestartWarning ? (
        <Popover onClose={() => setShowRestartWarning(false)} data-testid="qbit-recovery-restart-warning">
          <Column gap="lg" justifyCenter itemsCenter>
            <Text text={t('qbit_recovery_back_restart_warning')} textCenter wrap />
            <Text text={t('qbit_recovery_back_new_seed_warning')} preset="bold" textCenter wrap />
            <Row full>
              <Button
                text={t('cancel')}
                full
                data-testid="qbit-recovery-restart-cancel"
                onClick={() => setShowRestartWarning(false)}
              />
              <Button
                text={t('confirm')}
                preset="danger"
                full
                data-testid="qbit-recovery-restart-confirm"
                onClick={() => {
                  setShowRestartWarning(false);
                  navigate('#back');
                }}
              />
            </Row>
          </Column>
        </Popover>
      ) : null}
    </Layout>
  );
}
