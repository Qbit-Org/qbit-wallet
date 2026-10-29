import { Card, Column, Icon, Row, Text, Tooltip } from '@/ui/components';
import { ColorTypes } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { DecodedPsbt, ToSignData, isWebsiteSuppliedPsbt } from '@qbit/wallet-shared';
import { useI18n, useQbitUnit } from '@qbit/wallet-state';

import { SignPsbtSection } from './Section';

/** An nLockTime from this value is a Unix time; below it, a block height. */
const LOCKTIME_THRESHOLD = 500_000_000;
/** The sequence of a final input. When every input is final, nLockTime is not enforced. */
const SEQUENCE_FINAL = 0xffffffff;

/** A Unix time as `YYYY-MM-DD hh:mm:ss UTC`. */
function formatLocktimeTime(locktime: number): string {
  return new Date(locktime * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function TermRow({ label, value, detail, testId }: { label: string; value: string; detail?: string; testId: string }) {
  return (
    <Card
      mt="zero"
      style={{
        borderWidth: 1,
        borderColor: 'var(--qbit-line)',
        borderRadius: 0
      }}
    >
      <Row justifyBetween itemsCenter fullX>
        <Text text={label} color="textDim" size="sm" />
        <Column gap="zero" style={{ alignItems: 'flex-end', minWidth: 0 }}>
          <Text text={value} preset="bold" size="sm" textEnd wrap data-testid={testId} />
          {detail !== undefined && (
            <Text text={detail} size="xs" color="textDim" textEnd wrap data-testid={`${testId}-raw`} />
          )}
        </Column>
      </Row>
    </Card>
  );
}

interface TransactionOverviewSectionProps {
  decodedPsbt: DecodedPsbt;
  networkFee: any;
  toSignData?: ToSignData;
}

export default function TransactionOverviewSection({ decodedPsbt, networkFee, toSignData }: TransactionOverviewSectionProps) {
  const qbitUnit = useQbitUnit();
  const { t } = useI18n();

  const signatureBudget = toSignData?.signatureBudget;

  // The wallet warns only on abnormally high fees (see assessQbitFee), never on low ones.
  const getFeeRateColor = (): ColorTypes => (decodedPsbt.shouldWarnFeeRate ? 'dangerText' : 'text');

  const title = t('network_fees');

  // The fee was checked against the wallet's own bounds only; say so instead of implying it matched a live rate.
  const feeAssessment = decodedPsbt.spendSummary?.feeAssessment;
  const recommendationUnavailable = !!feeAssessment && feeAssessment.recommendedFeeRate === undefined;

  const showNetworkFee = decodedPsbt.isCompleted == true;

  const { locktime, version } = decodedPsbt;
  // nLockTime holds the transaction back unless it is 0 or every input is final.
  const lockEnforced =
    locktime !== undefined &&
    locktime !== 0 &&
    !decodedPsbt.inputInfos.every((input) => input.sequence === SEQUENCE_FINAL);

  // A website gets the signed PSBT back. Signing finalizes it unless the
  // request, as the background prepared it, says not to. The wallet cannot
  // tell whether an enforced lock time has passed, so with one it does not
  // say the site can broadcast the transaction now.
  const finalizeDecision = isWebsiteSuppliedPsbt(toSignData)
    ? toSignData?.autoFinalized === false
      ? t('psbt_not_finalized')
      : lockEnforced
        ? t('psbt_finalized_after_lock')
        : t('psbt_finalized')
    : undefined;

  let locktimeText: string | undefined;
  let locktimeDetail: string | undefined;
  if (locktime !== undefined) {
    if (!lockEnforced) {
      locktimeText = t('psbt_locktime_none');
    } else if (locktime < LOCKTIME_THRESHOLD) {
      locktimeText = t('psbt_locktime_block', `${locktime}`);
    } else {
      // Checked against the network's median time past, which runs about an hour behind clock time.
      locktimeText = t('psbt_locktime_median_time', formatLocktimeTime(locktime));
    }
    if (locktime !== 0) {
      locktimeDetail = lockEnforced ? `nLockTime ${locktime}` : t('psbt_locktime_not_enforced', `${locktime}`);
    }
  }

  const transactionSection =
    finalizeDecision !== undefined || locktimeText !== undefined || version !== undefined ? (
      <SignPsbtSection title={t('transaction')}>
        <Column gap="sm">
          {finalizeDecision !== undefined && (
            <TermRow label={t('psbt_after_signing')} value={finalizeDecision} testId="psbt-finalize-decision" />
          )}
          {locktimeText !== undefined && (
            <TermRow label={t('psbt_locktime')} value={locktimeText} detail={locktimeDetail} testId="psbt-locktime" />
          )}
          {version !== undefined && (
            <TermRow label={t('psbt_tx_version')} value={`${version}`} testId="psbt-tx-version" />
          )}
        </Column>
      </SignPsbtSection>
    ) : null;

  if (showNetworkFee === false) {
    return transactionSection;
  }

  const feeSection = (
    <SignPsbtSection title={title}>
      <Column gap="sm">
        <Card
          mt="zero"
          style={{
            borderWidth: 1,
            borderColor: 'var(--qbit-line)',
            borderRadius: 0
          }}
        >
          <Row justifyBetween itemsCenter fullX>
            <Text text={t('network_fee_2')} color="textDim" size="sm" />
            <Text text={networkFee.toString() + ' ' + qbitUnit} preset="bold" size="sm" />
          </Row>
        </Card>

        <Card
          mt="zero"
          style={{
            borderWidth: 1,
            borderColor: 'var(--qbit-line)',
            borderRadius: 0
          }}
        >
          <Row justifyBetween itemsCenter fullX>
            <Text text={t('fee_rate')} color="textDim" size="sm" />
            <Column gap="zero" style={{ alignItems: 'flex-end' }}>
              <Text text={`${decodedPsbt.feeRate} bits/vB`} preset="bold" size="sm" color={getFeeRateColor()} />
              <Text
                data-testid="psbt-network-fee-base-units"
                text={`Exact fee: ${decodedPsbt.fee} bits`}
                size="xs"
                color="textDim"
              />
            </Column>
          </Row>
        </Card>

        {recommendationUnavailable && (
          <Text
            text={t('fee_warning_recommendation_unavailable')}
            size="xs"
            color="warning"
            data-testid="psbt-fee-recommendation-unavailable"
          />
        )}

        {signatureBudget && (
          <Column gap="sm" fullX data-testid="psbt-signature-budget">
            <Text
              text={`Signatures: ${signatureBudget.required} new • ${signatureBudget.cached} cached`}
              size="xs"
              color="textDim"
            />
            {signatureBudget.restoredFloorRisk ? (
              <Row itemsCenter gap="sm">
                <Text
                  text={t(
                    'qbit_known_onchain_usage_lower_bound',
                    signatureBudget.restoredFloorRisk.knownOnChainSignatures > 0
                      ? `${signatureBudget.restoredFloorRisk.knownOnChainSignatures}+`
                      : '0'
                  )}
                  size="xs"
                  color="textDim"
                />
                <Tooltip title={t('qbit_recovery_counter_approximate_tip')} overlayStyle={{ fontSize: fontSizes.xs }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <Icon icon="circle-question" color="textDim" size={12} />
                  </div>
                </Tooltip>
              </Row>
            ) : (
              <Text
                text={`Signature budget: ${signatureBudget.remainingBefore} before, ${signatureBudget.remainingAfter} after`}
                size="xs"
                color="textDim"
              />
            )}
          </Column>
        )}
      </Column>
    </SignPsbtSection>
  );

  return (
    <>
      {feeSection}
      {transactionSection}
    </>
  );
}
