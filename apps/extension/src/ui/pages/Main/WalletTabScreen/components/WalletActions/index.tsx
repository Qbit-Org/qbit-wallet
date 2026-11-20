import { Row } from '@/ui/components';
import { Button, ButtonProps } from '@/ui/components/Button';
import {
  useCanCreateQbitSendRequest,
  useI18n,
  useNavigation,
  useResetFeeRateBar,
  useResetUiTxCreateScreen
} from '@qbit/wallet-state';

interface WalletActionsProps {
  hideReceive?: boolean;
}

type WalletActionItem = {
  key: string;
  label: string;
  icon: NonNullable<ButtonProps['icon']>;
  onClick: NonNullable<ButtonProps['onClick']>;
  disabled?: boolean;
  dataTestId: string;
};

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

export const WalletActions = ({ hideReceive }: WalletActionsProps) => {
  const nav = useNavigation();
  const resetUiTxCreateScreen = useResetUiTxCreateScreen();
  const resetFeeRateBar = useResetFeeRateBar();
  const { t } = useI18n();
  const canCreateQbitSend = useCanCreateQbitSendRequest();

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

  const actionItems: WalletActionItem[] = [];

  if (!hideReceive) {
    actionItems.push({
      key: 'receive',
      label: t('receive'),
      icon: 'receive',
      onClick: onReceiveClick,
      dataTestId: 'receive-button'
    });
  }

  actionItems.push({
    key: 'send',
    label: t('send'),
    icon: 'send',
    onClick: onSendClick,
    disabled: !canCreateQbitSend,
    dataTestId: 'send-button'
  });

  actionItems.push({
    key: 'history',
    label: t('history'),
    icon: 'history',
    onClick: () => onHistoryClick(),
    dataTestId: 'history-button'
  });

  return (
    <Row justifyCenter mt="md" style={{ flexWrap: 'wrap' }}>
      {actionItems.map((action) => (
        <Button
          key={action.key}
          text={action.label}
          preset="home"
          icon={action.icon}
          iconSize={actionButtonIconSize}
          onClick={action.onClick}
          disabled={action.disabled}
          style={actionButtonStyle}
          textStyle={actionButtonTextStyle}
          max2Lines
          data-testid={action.dataTestId}
        />
      ))}
    </Row>
  );
};
