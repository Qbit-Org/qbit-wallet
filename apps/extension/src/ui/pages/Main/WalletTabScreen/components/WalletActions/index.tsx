import { useEffect, useMemo, useState } from 'react';

import { Row } from '@/ui/components';
import { Button, ButtonProps } from '@/ui/components/Button';
import { TypeChain } from '@qbit/wallet-shared';
import {
  useCanCreateQbitSendRequest,
  useCurrentAccountCapabilities,
  useI18n,
  useNavigation,
  useResetFeeRateBar,
  useResetUiTxCreateScreen,
  useWalletConfig
} from '@qbit/wallet-state';

interface WalletActionsProps {
  chain: TypeChain;
  hideReceive?: boolean;
}

type WalletActionItem = {
  key: string;
  label: string;
  icon: NonNullable<ButtonProps['icon']>;
  onClick: NonNullable<ButtonProps['onClick']>;
  disabled?: boolean;
  priority: number;
  overflowPreset?: ButtonProps['preset'];
  dataTestId: string;
};

const MAX_PRIMARY_ACTIONS = 4;
const ACTION_BUTTON_SIZE = 64;
const actionButtonStyle = {
  minWidth: ACTION_BUTTON_SIZE,
  minHeight: ACTION_BUTTON_SIZE,
  width: ACTION_BUTTON_SIZE
};
const actionButtonTextStyle = {
  fontSize: 10,
  lineHeight: '14px'
};
const actionButtonIconSize = { width: 18, height: 18 };

export const WalletActions = ({ chain, hideReceive }: WalletActionsProps) => {
  const [showOverflowActions, setShowOverflowActions] = useState(false);
  const nav = useNavigation();
  const resetUiTxCreateScreen = useResetUiTxCreateScreen();
  const resetFeeRateBar = useResetFeeRateBar();
  const walletConfig = useWalletConfig();
  const { t } = useI18n();
  const accountCapabilities = useCurrentAccountCapabilities();
  const canCreateQbitSend = useCanCreateQbitSendRequest();

  const handleUtxoClick = () => {
    nav.navToUtxoTools();
  };

  const onReceiveClick = () => {
    nav.navigate('ReceiveScreen');
  };

  const onSendClick = () => {
    resetUiTxCreateScreen();
    resetFeeRateBar();
    nav.navigate('TxCreateScreen');
  };

  const onHistoryClick = () => {
    // In-app history works on every network; the external explorers behind
    // navToExplorerAddress are not live for qbit chains.
    nav.navigate('HistoryScreen');
  };

  const actionItems = useMemo<WalletActionItem[]>(() => {
    const items: WalletActionItem[] = [];

    if (!hideReceive) {
      items.push({
        key: 'receive',
        label: t('receive'),
        icon: 'receive',
        onClick: onReceiveClick,
        priority: 1,
        dataTestId: 'receive-button'
      });
    }

    items.push({
      key: 'send',
      label: t('send'),
      icon: 'send',
      onClick: onSendClick,
      disabled: !canCreateQbitSend,
      priority: 2,
      dataTestId: 'send-button'
    });

    items.push({
      key: 'history',
      label: t('history'),
      icon: 'history',
      onClick: () => onHistoryClick(),
      priority: 4,
      overflowPreset: 'homeGold',
      dataTestId: 'history-button'
    });

    if (!walletConfig.disableUtxoTools) {
      items.push({
        key: 'utxo',
        label: t('utxo').toUpperCase(),
        icon: 'utxo',
        onClick: handleUtxoClick,
        disabled: !accountCapabilities.canCreateSigningRequest,
        priority: 6,
        overflowPreset: 'homeGold',
        dataTestId: 'utxo-button'
      });
    }

    return items;
  }, [accountCapabilities.canCreateSigningRequest, canCreateQbitSend, handleUtxoClick, hideReceive, t, walletConfig.disableUtxoTools]);

  const { primaryActions, overflowActions } = useMemo(() => {
    const items = actionItems.sort((a, b) => a.priority - b.priority);
    let primaryActions: WalletActionItem[] = [];
    let overflowActions: WalletActionItem[] = [];
    if (items.length <= MAX_PRIMARY_ACTIONS) {
      primaryActions = items;
    } else {
      primaryActions = items.slice(0, MAX_PRIMARY_ACTIONS - 1);
      overflowActions = items.slice(MAX_PRIMARY_ACTIONS - 1);
    }

    return {
      primaryActions,
      overflowActions
    };
  }, [actionItems]);

  useEffect(() => {
    setShowOverflowActions(false);
  }, [chain.enum, overflowActions.length]);

  const renderActionButton = (action: WalletActionItem, location: 'primary' | 'overflow') => (
    <Button
      key={action.key}
      text={action.label}
      preset={location === 'overflow' ? action.overflowPreset || 'home' : 'home'}
      icon={action.icon}
      iconSize={actionButtonIconSize}
      onClick={action.onClick}
      disabled={action.disabled}
      style={actionButtonStyle}
      textStyle={actionButtonTextStyle}
      max2Lines
      data-testid={action.dataTestId}
    />
  );

  return (
    <>
      <Row justifyCenter mt="md" style={{ flexWrap: 'wrap' }}>
        {primaryActions.map((action) => renderActionButton(action, 'primary'))}
        {overflowActions.length > 0 && (
          <Button
            text={t('more')}
            preset={showOverflowActions ? 'homeGold' : 'home'}
            icon="more"
            iconSize={actionButtonIconSize}
            onClick={() => setShowOverflowActions((prev) => !prev)}
            style={actionButtonStyle}
            textStyle={actionButtonTextStyle}
            max2Lines
            data-testid="more-button"
          />
        )}
      </Row>

      {showOverflowActions && overflowActions.length > 0 && (
        <Row justifyCenter mt="md" style={{ flexWrap: 'wrap' }}>
          {/* add empty action place to align the overflow button to the right*/}
          {MAX_PRIMARY_ACTIONS - overflowActions.length > 0 && (
            <Button preset="homeGold" style={{ ...actionButtonStyle, opacity: 0 }}></Button>
          )}
          {MAX_PRIMARY_ACTIONS - overflowActions.length > 1 && (
            <Button preset="homeGold" style={{ ...actionButtonStyle, opacity: 0 }}></Button>
          )}
          {MAX_PRIMARY_ACTIONS - overflowActions.length > 2 && (
            <Button preset="homeGold" style={{ ...actionButtonStyle, opacity: 0 }}></Button>
          )}

          {overflowActions.map((action) => renderActionButton(action, 'overflow'))}
        </Row>
      )}

    </>
  );
};
