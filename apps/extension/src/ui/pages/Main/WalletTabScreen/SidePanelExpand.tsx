import { useEffect, useState } from 'react';

import { Icon, Row, Tooltip } from '@/ui/components';
import { getUiType } from '@/ui/web';
import { useI18n, useWallet } from '@qbit/wallet-state';

export function SidePanelExpand() {
  const { t } = useI18n();
  const UIType = getUiType();
  const isInSidePanel = UIType.isSidePanel;
  const wallet = useWallet();
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (isInSidePanel) {
      wallet.setOpenInSidePanel(true);
    }
  }, [isInSidePanel, wallet]);

  const toggleSidePanel = async () => {
    try {
      if (isInSidePanel) {
        await wallet.setOpenInSidePanel(false);
        window.close();
      } else {
        const windowId = (await chrome.windows.getCurrent()).id;
        // sidePanel.open() requires an active user gesture. Awaiting the
        // background round-trip first voids the gesture and Chrome rejects
        // the call, so open the panel before persisting the preference.
        await (chrome as any).sidePanel.open({ windowId });
        await wallet.setOpenInSidePanel(true);
      }
    } catch (error) {
      console.error('SidePanelExpand error:', error);
    }
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
        title={isInSidePanel ? t('open_as_popup') : t('open_as_side_bar')}
        overlayStyle={{
          minWidth: '70px',
          fontSize: '12px'
        }}
        placement="bottom"
      >
        <div
          onClick={toggleSidePanel}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{ display: 'inline-block', cursor: 'pointer' }}
        >
          <Icon
            icon={isInSidePanel ? 'side-panel-logo-close' : 'side-panel-logo'}
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
