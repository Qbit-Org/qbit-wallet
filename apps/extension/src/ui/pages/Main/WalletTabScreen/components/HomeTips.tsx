import { Column, Text } from '@/ui/components';
import { useAddressTips, useWalletConfig } from '@qbit/wallet-state';

export function HomeTips() {
  const walletConfig = useWalletConfig();
  const addressTips = useAddressTips();
  if (walletConfig.chainTip || walletConfig.statusMessage || addressTips.homeTip) {
    return (
      <Column
        py={'lg'}
        px={'md'}
        gap={'lg'}
        style={{
          borderRadius: 0,
          border: '1px solid rgba(245, 84, 84, 0.35)',
          background: 'rgba(245, 84, 84, 0.08)'
        }}
      >
        {walletConfig.chainTip && <Text text={walletConfig.chainTip} color="text" textCenter />}
        {walletConfig.statusMessage && <Text text={walletConfig.statusMessage} color="dangerText" textCenter />}
        {addressTips.homeTip && <Text text={addressTips.homeTip} color="warning" textCenter />}
      </Column>
    );
  }
  return undefined;
}
