import { Column, Icon, Row, Text, Tooltip } from '@/ui/components';
import { RefreshButton } from '@/ui/components/RefreshButton';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
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

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance
  } = useBalanceCardLogic();

  const stopCardToggle = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  return (
    <Column
      data-testid="wallet-balance-card"
      style={{
        backgroundColor: colors.accent,
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
          <Text size="sm" text={t('total_balance')} style={{ color: colors.onPrimary }} />
          <Row
            style={{ padding: 6, margin: -6 }}
            onClick={(event) => {
              stopCardToggle(event);
              handleHiddenToggle();
            }}
          >
            <Icon color={'onPrimary'} icon={isBalanceHidden ? 'balance-eyes-closed' : 'balance-eyes'} size={20} />
          </Row>
          <RefreshButton onClick={refreshBalance as any} hideText />
        </Row>

        <Row itemsCenter>
          <QbitDisplay balance={balanceValue} hideBalance={isBalanceHidden} />
          <Icon color={'onPrimary'} size={16} icon={isDetailExpanded ? 'up' : 'down'} />
        </Row>
        {utxoLimitExceeded ? (
          <Text
            size="xs"
            text={utxoLimitExceededText}
            style={{ color: colors.onPrimary }}
            data-testid="balance-utxo-limit-note"
          />
        ) : null}
      </Column>

      {isDetailExpanded && isCurrentChainBalance && (
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
