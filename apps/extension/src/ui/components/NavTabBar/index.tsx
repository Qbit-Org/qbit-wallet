import { useState } from 'react';

import { colors } from '@/ui/theme/colors';
import { TabOption, useNavigation } from '@qbit/wallet-state';

import { Column } from '../Column';
import { Grid } from '../Grid';
import { Icon, IconTypes } from '../Icon';
import { markMineTabSeen, readMineTabSeen } from './mineTabSeen';

export function NavTabBar({ tab }: { tab: TabOption }) {
  // Read once per mount: every tab screen mounts its own NavTabBar, so the
  // badge reflects the stored flag after each tab switch.
  const [mineTabSeen] = useState(readMineTabSeen);

  return (
    <Grid
      columns={4}
      style={{
        width: '100%',
        height: '67.5px',
        backgroundColor: colors.surface,
        borderTop: `1px solid ${colors.border}`
      }}
    >
      <TabButton tabName="home" icon="qbitWallet" iconSize={26.45} isActive={tab === 'home'} data-testid="tab-home" />
      <TabButton
        tabName="mine"
        icon="mine"
        isActive={tab === 'mine'}
        showNewBadge={!mineTabSeen && tab !== 'mine'}
        data-testid="tab-mine"
      />
      <TabButton tabName="discover" icon="compass" isActive={tab === 'discover'} data-testid="tab-discover" />
      <TabButton tabName="settings" icon="settings" isActive={tab === 'settings'} data-testid="tab-settings" />
    </Grid>
  );
}

function TabButton({
  tabName,
  icon,
  iconSize = 20,
  isActive,
  showNewBadge = false,
  'data-testid': dataTestId
}: {
  tabName: TabOption;
  icon: IconTypes;
  iconSize?: number;
  isActive: boolean;
  showNewBadge?: boolean;
  'data-testid'?: string;
}) {
  const nav = useNavigation();

  return (
    <Column
      justifyCenter
      itemsCenter
      onClick={(e) => {
        if (tabName === 'home') {
          nav.navigate('MainScreen');
        } else if (tabName === 'mine') {
          markMineTabSeen();
          nav.navigate('MineTabScreen');
        } else if (tabName === 'discover') {
          nav.navigate('DiscoverTabScreen');
        } else if (tabName === 'settings') {
          nav.navigate('SettingsTabScreen');
        }
      }}
      data-testid={dataTestId}
    >
      <div style={{ position: 'relative', display: 'flex' }}>
        <Icon size={iconSize} icon={icon} color={isActive ? 'accentDark' : 'muted'} />
        {showNewBadge && <NewBadge />}
      </div>
    </Column>
  );
}

function NewBadge() {
  return (
    <span
      data-testid="tab-new-badge"
      style={{
        position: 'absolute',
        top: -7,
        left: '100%',
        marginLeft: 2,
        padding: '1px 4px',
        fontSize: 8,
        fontWeight: 700,
        lineHeight: 1.3,
        letterSpacing: 0.4,
        color: colors.onPrimary,
        backgroundColor: colors.primary,
        whiteSpace: 'nowrap',
        pointerEvents: 'none'
      }}
    >
      NEW
    </span>
  );
}
