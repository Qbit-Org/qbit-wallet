import { LoaderCircle } from 'lucide-react';

import { Column, Icon, Progress, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { getUiType } from '@/ui/utils';
import { SigningProgressState, useI18n } from '@qbit/wallet-state';

/** A transaction signing this many inputs or more shows its progress while it signs. */
export const SIGNING_PROGRESS_MIN_INPUTS = 4;
/** A transaction signing this many inputs or more says, before Sign, that signing takes a while. */
export const LONG_SIGNING_NOTICE_MIN_INPUTS = 20;

const noticeStyle = {
  backgroundColor: colors.warning_bg,
  border: `1px solid ${colors.warning_content}`,
  borderRadius: 8,
  padding: `${spacing.small}px ${spacing.medium}px`,
  width: '100%',
  boxSizing: 'border-box' as const
};

function NoticeTitle({ text }: { text: string }) {
  return (
    <Row itemsCenter gap="sm">
      <Icon icon="alert" color="warning" size={16} />
      <Text text={text} preset="bold" color="warning" />
    </Row>
  );
}

/**
 * What a signing screen shows while a local signing runs: how far it has got,
 * the time left once it can be measured, and that the wallet must stay open
 * until it finishes. A popup closes when the user clicks outside it, so the
 * popup says that too. `handedOff` says the page has handed the signed
 * transaction to its broadcast or approval, which closing the wallet no
 * longer stops: the panel then reads as signed, without the notice. Every
 * input signed is not enough, since until the handoff the result still needs
 * this page.
 */
export function SigningProgress({
  progress,
  handedOff = false
}: {
  progress: SigningProgressState | null;
  handedOff?: boolean;
}) {
  const { t } = useI18n();
  const isPopup = getUiType().isPop;
  const signed = progress?.signed;
  const total = progress?.total;
  const counted = signed !== undefined && total !== undefined && total > 0;
  const percent = counted ? (signed / total) * 100 : 0;
  const count = counted ? t('signing_progress_inputs', [`${signed}`, `${total}`]) : t('signing_progress_starting');
  const transactionIndex = progress?.transactionIndex;
  const transactionCount = progress?.transactionCount;
  const remainingMs = progress?.remainingMs;
  let timeLeft: string | undefined;
  if (remainingMs !== undefined) {
    timeLeft =
      remainingMs < 60_000
        ? t('signing_progress_under_a_minute')
        : t('signing_progress_minutes_left', `${Math.round(remainingMs / 60_000)}`);
  }

  return (
    <Column gap="xl" fullX itemsCenter data-testid="signing-progress">
      {handedOff ? (
        <Icon icon="circle-check" size={fontSizes.xxxl} color="green" />
      ) : (
        <Icon size={fontSizes.xxxl} color="gold">
          <LoaderCircle className="icon-spin" size="1em" />
        </Icon>
      )}
      <Column gap="sm" fullX itemsCenter>
        <Text
          text={handedOff ? t('signed') : t('signing_progress_title')}
          preset="title-bold"
          textCenter
          data-testid="signing-progress-title"
        />
        {transactionIndex !== undefined && transactionCount !== undefined && transactionCount > 1 && (
          <Text
            text={t('signing_progress_transaction', [`${transactionIndex + 1}`, `${transactionCount}`])}
            color="textDim"
            textCenter
            data-testid="signing-progress-transaction"
          />
        )}
      </Column>
      <Column gap="sm" fullX>
        <Progress
          percent={percent}
          showInfo={false}
          size="large"
          ariaLabel={t('signing_progress_title')}
          ariaValueText={count}
          data-testid="signing-progress-bar"
        />
        <Row justifyBetween itemsCenter fullX gap="sm">
          <Text text={count} size="sm" data-testid="signing-progress-count" />
          {timeLeft && <Text text={timeLeft} size="sm" color="textDim" data-testid="signing-progress-time-left" />}
        </Row>
      </Column>
      {!handedOff && (
        <div role="note" style={noticeStyle} data-testid="signing-keep-open-notice">
          <Column gap="sm" fullX>
            <NoticeTitle text={t('signing_keep_open_title')} />
            <Text text={t(isPopup ? 'signing_keep_open_popup' : 'signing_keep_open')} size="xs" wrap />
          </Column>
        </div>
      )}
    </Column>
  );
}

/**
 * Shown before Sign for a transaction with many inputs: signing them takes a
 * while, and the wallet must stay open until it finishes. In the popup, it
 * also points to the sidebar, which stays open while the user works in
 * other tabs.
 */
export function LongSigningNotice({ inputCount }: { inputCount: number }) {
  const { t } = useI18n();
  const isPopup = getUiType().isPop;
  return (
    <div role="note" style={noticeStyle} data-testid="long-signing-notice">
      <Column gap="sm" fullX>
        <NoticeTitle text={t('signing_many_inputs_title')} />
        <Text text={t('signing_many_inputs_body', `${inputCount}`)} size="xs" wrap />
        {isPopup && <Text text={t('signing_many_inputs_sidebar')} size="xs" color="textDim" wrap />}
      </Column>
    </div>
  );
}
