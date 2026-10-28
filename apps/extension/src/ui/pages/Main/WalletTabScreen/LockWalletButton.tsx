import { useState } from 'react';

import { Icon, Row, Tooltip } from '@/ui/components';
import { useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';

export function LockWalletButton() {
  const { t } = useI18n();
  const wallet = useWallet();
  const nav = useNavigation();
  const tools = useTools();
  const [isHovered, setIsHovered] = useState(false);

  const lockWallet = () => {
    // Navigate only after the lock round-trip succeeds; if the wallet is
    // still unlocked, the unlock screen would just bounce straight back to
    // main, so a failed lock surfaces a toast instead.
    wallet
      .lockWallet()
      .then(() => {
        nav.navToLock({
          autoUnlockByFace: false
        });
      })
      .catch((error: unknown) => {
        console.error('LockWalletButton error:', error);
        tools.toastError(t('failed_to_lock_wallet'));
      });
  };

  return (
    <Row
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
    >
      <Tooltip
        title={t('lock_wallet')}
        overlayStyle={{
          minWidth: '70px',
          fontSize: '12px'
        }}
        placement="bottom"
      >
        <div
          onClick={lockWallet}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{ display: 'inline-block', cursor: 'pointer' }}
          data-testid="lock-wallet-button"
        >
          <Icon
            icon="lock"
            size={20}
            color={isHovered ? 'accent' : 'muted'}
            containerStyle={{
              opacity: isHovered ? 1 : 0.8
            }}
          />
        </div>
      </Tooltip>
    </Row>
  );
}
