import { Column, Icon, Row, Text, Tooltip } from '@/ui/components';
import { BulletedTip } from '@/ui/components/Tooltip/BulletedTip';
import { ColorTypes, colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing, spacingGap } from '@/ui/theme/spacing';
import { useBalanceCardLogic } from '@qbit/wallet-state';

import {
  BALANCE_SPLIT_DIMMED_OPACITY,
  BALANCE_SPLIT_LINE_HEIGHT,
  BALANCE_TOTAL_DIMMED_OPACITY,
  BALANCE_TOTAL_LINE_HEIGHT,
  VISUALLY_HIDDEN
} from './balanceCardLayout';
import { BalanceLineLoader } from './BalanceLineLoader';
import { BalanceRefreshControl } from './BalanceRefreshControl';
import { BalanceStatusText } from './BalanceStatusText';
import { QbitDisplay } from './QbitDisplay';

export function BalanceCard() {
  const {
    status,
    statusText,
    statusShortText,
    liveText,
    balanceErrorText,
    outputsUnread,
    outputsUnreadText,
    outputsUnreadDetailText,
    totalDimmed,
    splitDimmed,
    availableAmount,
    unavailableAmount,
    unavailableTipText,
    balanceValue,
    t,
    utxoLimitExceeded,
    utxoLimitExceededText,
    balanceSplitUnknown,
    balanceSplitUnknownText,

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance,
    canRefresh
  } = useBalanceCardLogic();

  const stopCardToggle = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  // With no balance to show, the card drops the brand fill for a neutral grey.
  const nothingShown = status.kind === 'failed-empty';
  const cardBackground = nothingShown ? colors.neutralFill : colors.accent;
  const onCard: ColorTypes = nothingShown ? 'onNeutralFill' : 'onPrimary';
  const failing = status.kind === 'failed' || status.kind === 'failed-empty';
  // A value that is out of date shows dimmed: the total less than the split,
  // each as far as its size and background allow (`balanceCardLayout`).
  const totalOpacity = totalDimmed ? BALANCE_TOTAL_DIMMED_OPACITY : 1;
  const splitOpacity = splitDimmed ? BALANCE_SPLIT_DIMMED_OPACITY : 1;
  const split =
    status.kind === 'loading' || status.kind === 'failed-empty' ? ({ kind: 'loading' } as const) : status.shown.split;
  // A hidden balance shows `****` in place of every loader, as it does in
  // place of every number; the refresh control still says the card is busy.
  // Outputs that could not be read show `--`, nothing spinning.
  const totalLoading = status.kind === 'loading' && !isBalanceHidden;
  const splitLoading = split.kind === 'loading' && !outputsUnread && !isBalanceHidden;

  // Each number sits on a line of fixed height, whatever stands on it, so
  // that the card keeps its height and its rows their places in every state
  // but a failure, which alone adds a message. Inside the line, one box holds
  // the value or the loader in its place (`balance-total`, `balance-available`,
  // `balance-unavailable`), for its rendered size to be measured.
  const splitLine = (amount: string, name: 'available' | 'unavailable') => (
    <div
      data-testid={`balance-${name}-line`}
      style={{ display: 'flex', alignItems: 'center', height: BALANCE_SPLIT_LINE_HEIGHT, opacity: splitOpacity }}
    >
      <div data-testid={`balance-${name}`} style={{ display: 'flex', alignItems: 'center' }}>
        {splitLoading ? (
          <BalanceLineLoader
            height={BALANCE_SPLIT_LINE_HEIGHT}
            label={t('balance_loading')}
            announce={!totalLoading && name === 'available'}
            data-testid={`balance-${name}-loading`}
          />
        ) : (
          <QbitDisplay preset="sub" balance={amount} hideBalance={isBalanceHidden} />
        )}
      </div>
    </div>
  );

  return (
    <div
      data-testid="wallet-balance-card"
      data-status={status.kind}
      data-detail-open={isDetailExpanded ? 'true' : 'false'}
      aria-busy={status.busy}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: spacingGap.md,
        backgroundColor: cardBackground,
        borderRadius: 0,
        padding: 8,
        position: 'relative',
        cursor: 'pointer'
      }}
      onClick={() => {
        handleExpandToggle();
      }}
    >
      <Column style={{ padding: 8 }} gap={'md'}>
        <Row itemsCenter justifyBetween style={{ gap: spacingGap.md }}>
          {/* "Wallet Balance" keeps its room and its one line, whatever is beside the control. */}
          <Row itemsCenter style={{ whiteSpace: 'nowrap', flexShrink: 0 }} data-testid="balance-label">
            <Text size="sm" text={t('wallet_balance')} style={{ color: colors[onCard], whiteSpace: 'nowrap' }} />
            <Tooltip
              title={t(isBalanceHidden ? 'show_balance' : 'hide_balance')}
              overlayStyle={{ fontSize: fontSizes.xs }}
            >
              <Row
                style={{ padding: 6, margin: -6 }}
                data-testid="balance-visibility-toggle"
                onClick={(event) => {
                  stopCardToggle(event);
                  handleHiddenToggle();
                }}
              >
                <Icon color={onCard} icon={isBalanceHidden ? 'balance-eyes-closed' : 'balance-eyes'} size={20} />
              </Row>
            </Tooltip>
          </Row>
          <Row itemsCenter gap="md" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
            {/* Told to a screen reader politely as the card starts updating, not on every count or poll. */}
            <span aria-live="polite" data-testid="balance-live" style={VISUALLY_HIDDEN}>
              {liveText ?? ''}
            </span>
            {/* "Updating…", or how far a long read has got, in short, where it fits whole. */}
            <BalanceStatusText text={statusShortText} color={colors[onCard]} />
            {/* One tooltip, the wallet's: the full sentence, or what the control does. */}
            <Tooltip title={statusText ?? t('refresh_balance')} overlayStyle={{ fontSize: fontSizes.xs }}>
              <BalanceRefreshControl
                busy={status.busy}
                label={t('refresh_balance')}
                description={statusText}
                failing={failing}
                readable={canRefresh}
                color={onCard}
                onRefresh={refreshBalance as (event: unknown) => void}
              />
            </Tooltip>
          </Row>
        </Row>

        {nothingShown ? null : (
          <Row itemsCenter>
            <div
              data-testid="balance-total-line"
              style={{
                display: 'flex',
                alignItems: 'center',
                height: BALANCE_TOTAL_LINE_HEIGHT,
                opacity: totalOpacity
              }}
            >
              <div data-testid="balance-total" style={{ display: 'flex', alignItems: 'center' }}>
                {totalLoading ? (
                  <BalanceLineLoader
                    height={BALANCE_TOTAL_LINE_HEIGHT}
                    label={t('balance_loading')}
                    announce
                    data-testid="balance-loading"
                  />
                ) : (
                  <QbitDisplay balance={balanceValue} hideBalance={isBalanceHidden} />
                )}
              </div>
            </div>
            <Icon color={'onPrimary'} size={16} icon={isDetailExpanded ? 'up' : 'down'} />
          </Row>
        )}
        {balanceErrorText ? (
          // A quiet box, the surface's own colours in either theme: it says
          // what failed once (`role="alert"`); the refresh control reads again.
          <div
            role="alert"
            data-testid="balance-error"
            onClick={stopCardToggle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacingGap.md,
              backgroundColor: colors.surface,
              color: colors.text,
              padding: `${spacing.extraSmall}px ${spacing.small}px`
            }}
          >
            <Icon icon="alert" color="text" size={16} />
            <Text
              size="xs"
              text={balanceErrorText}
              style={{ flex: 1, color: colors.text }}
              data-testid="balance-error-note"
            />
          </div>
        ) : null}
        {outputsUnreadText ? (
          // The total stands; its outputs could not be read. Said once, where
          // the limit note sits, as plain text on the card.
          <div role="alert">
            <Text
              size="xs"
              text={outputsUnreadText}
              style={{ color: colors.onPrimary }}
              data-testid="balance-outputs-note"
            />
          </div>
        ) : null}
        {utxoLimitExceeded ? (
          <Text
            size="xs"
            text={utxoLimitExceededText}
            style={{ color: colors.onPrimary }}
            data-testid="balance-utxo-limit-note"
          />
        ) : null}
      </Column>

      {isDetailExpanded && !nothingShown && (
        <Column
          gap={'sm'}
          style={{
            alignSelf: 'stretch',
            boxSizing: 'border-box',
            padding: 12,
            backgroundColor: 'rgba(0, 0, 0, 0.08)',
            borderRadius: 0
          }}
        >
          <Row justifyBetween itemsCenter>
            <Column style={{ flex: 1 }} gap={'zero'}>
              <Row>
                <Text color={'onPrimary'} size="xs" text={t('available')} style={{ fontWeight: 500 }}></Text>
                <Row style={{ height: 20 }} />
              </Row>
              {splitLine(availableAmount, 'available')}
            </Column>

            <div
              style={{
                width: 1,
                borderWidth: 1,
                height: '100%',
                borderColor: 'rgba(0, 0, 0, 0.12)',
                marginRight: 5
              }}
            />

            <Column style={{ flex: 1 }} gap={'zero'}>
              <Row itemsCenter gap="sm" style={{ minHeight: 20 }}>
                <Text color={'onPrimary'} size="xs" text={t('unavailable')} style={{ fontWeight: 500 }}></Text>
                {/* The tooltip explains a measured Unavailable; an unknown one has none. */}
                {split.kind === 'known' ? (
                  <Tooltip
                    title={<BulletedTip text={unavailableTipText} />}
                    overlayStyle={{
                      fontSize: fontSizes.xs
                    }}
                  >
                    <Icon icon="circle-question" color={'onPrimary'} size={14} />
                  </Tooltip>
                ) : null}
              </Row>
              {splitLine(unavailableAmount, 'unavailable')}
            </Column>
          </Row>
          {balanceSplitUnknown ? (
            <Text
              size="xs"
              text={balanceSplitUnknownText}
              style={{ color: colors.onPrimary }}
              data-testid="balance-split-unknown-note"
            />
          ) : outputsUnreadDetailText ? (
            <Text
              size="xs"
              text={outputsUnreadDetailText}
              style={{ color: colors.onPrimary }}
              data-testid="balance-outputs-detail-note"
            />
          ) : null}
        </Column>
      )}
    </div>
  );
}
