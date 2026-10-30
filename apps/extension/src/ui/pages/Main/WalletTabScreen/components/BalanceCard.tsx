import { Button, Column, Icon, Row, Spin, Text, Tooltip } from '@/ui/components';
import { RefreshButton } from '@/ui/components/RefreshButton';
import { ColorTypes, colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { useBalanceCardLogic } from '@qbit/wallet-state';

import { QbitDisplay } from './QbitDisplay';

export function BalanceCard() {
  const {
    availableAmount,
    unavailableAmount,
    unavailableTipText,
    balanceValue,
    t,
    isCurrentChainBalance,
    utxoLimitExceeded,
    utxoLimitExceededText,
    balanceSplitUnknown,
    balanceSplitUnknownText,
    balanceLoading,
    balanceLoadFailed,
    balanceErrorText,

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance,
    retryBalance,
    isRetryingBalance
  } = useBalanceCardLogic();

  const stopCardToggle = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  // With no balance to show, the card drops the brand fill for a neutral grey.
  const cardBackground = balanceLoadFailed ? colors.neutralFill : colors.accent;
  const onCard: ColorTypes = balanceLoadFailed ? 'onNeutralFill' : 'onPrimary';

  return (
    <Column
      data-testid="wallet-balance-card"
      style={{
        backgroundColor: cardBackground,
        borderRadius: 0,
        padding: 8,
        position: 'relative'
      }}
      onClick={() => {
        handleExpandToggle();
      }}
    >
      <Column style={{ padding: 8 }} gap={'md'}>
        <Row itemsCenter>
          <Text size="sm" text={t('wallet_balance')} style={{ color: colors[onCard] }} />
          <Row
            style={{ padding: 6, margin: -6 }}
            onClick={(event) => {
              stopCardToggle(event);
              handleHiddenToggle();
            }}
          >
            <Icon color={onCard} icon={isBalanceHidden ? 'balance-eyes-closed' : 'balance-eyes'} size={20} />
          </Row>
          <RefreshButton onClick={refreshBalance as any} hideText color={onCard} />
        </Row>

        {balanceLoadFailed ? null : (
          <Row itemsCenter>
            {balanceLoading && !isBalanceHidden ? (
              // Same height as the amount row, so the card does not jump when the balance arrives.
              <div
                role="status"
                aria-label={t('balance_loading')}
                data-testid="balance-loading"
                style={{ display: 'flex', alignItems: 'center', height: 34 }}
              >
                <Spin color={colors.onPrimary} trackColor="rgba(0, 0, 0, 0.12)" />
              </div>
            ) : (
              <QbitDisplay balance={balanceValue} hideBalance={isBalanceHidden} />
            )}
            {balanceLoading ? null : <Icon color={'onPrimary'} size={16} icon={isDetailExpanded ? 'up' : 'down'} />}
          </Row>
        )}
        {balanceErrorText ? (
          <Column gap="md" data-testid="balance-error" onClick={stopCardToggle}>
            <Row
              itemsCenter
              gap="md"
              style={{
                // Paper under the translucent warning fill, so the box looks as
                // it does on other surfaces instead of tinting with the card.
                backgroundColor: colors.surface,
                backgroundImage: `linear-gradient(${colors.warning_bg}, ${colors.warning_bg})`,
                border: `1px solid ${colors.warning_content}`,
                padding: `${spacing.extraSmall}px ${spacing.small}px`
              }}
            >
              <Icon icon="alert" color="warning" size={16} />
              <Text size="xs" text={balanceErrorText} style={{ flex: 1 }} data-testid="balance-error-note" />
            </Row>
            <Button
              text={t('try_again')}
              preset={balanceLoadFailed ? 'neutral' : 'default'}
              loading={isRetryingBalance}
              style={{ minHeight: 36 }}
              data-testid="balance-retry-button"
              onClick={retryBalance}
            />
          </Column>
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

      {isDetailExpanded && isCurrentChainBalance && !balanceLoading && !balanceLoadFailed && (
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
              <QbitDisplay preset="sub" balance={availableAmount} hideBalance={isBalanceHidden} />
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
              <Row itemsCenter>
                <Text color={'onPrimary'} size="xs" text={t('unavailable')} style={{ fontWeight: 500 }}></Text>
                {/* The tooltip explains a measured Unavailable; an unknown split has the line below. */}
                {balanceSplitUnknown ? (
                  <Row style={{ height: 20 }} />
                ) : (
                  <Tooltip
                    title={unavailableTipText}
                    overlayStyle={{
                      fontSize: fontSizes.xs
                    }}
                  >
                    <Icon
                      icon="balance-question"
                      color={'onPrimary'}
                      size={20}
                      style={{
                        marginBottom: 10
                      }}
                    />
                  </Tooltip>
                )}
              </Row>
              <QbitDisplay preset="sub" balance={unavailableAmount} hideBalance={isBalanceHidden} />
            </Column>
          </Row>
          {balanceSplitUnknown ? (
            <Text
              size="xs"
              text={balanceSplitUnknownText}
              style={{ color: colors.onPrimary }}
              data-testid="balance-split-unknown-note"
            />
          ) : null}
        </Column>
      )}
    </Column>
  );
}
