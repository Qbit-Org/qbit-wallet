import { colors } from '@/ui/theme/colors';
import { TabOption, useNavigation, useUnreadNotificationsCount } from '@qbit/wallet-state';

import { BaseView } from '../BaseView';
import { Column } from '../Column';
import { Grid } from '../Grid';
import { Icon, IconTypes } from '../Icon';

export function NavTabBar({ tab }: { tab: TabOption }) {
  return (
    <Grid
      columns={3}
      style={{
        width: '100%',
        height: '67.5px',
        backgroundColor: colors.surface,
        borderTop: `1px solid ${colors.border}`
      }}
    >
      <TabButton tabName="home" icon="qbitWallet" iconSize={26.45} isActive={tab === 'home'} data-testid="tab-home" />
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
  'data-testid': dataTestId
}: {
  tabName: TabOption;
  icon: IconTypes;
  iconSize?: number;
  isActive: boolean;
  'data-testid'?: string;
}) {
  const nav = useNavigation();
  const unreadNotificationCount = useUnreadNotificationsCount();

  return (
    <Column
      justifyCenter
      itemsCenter
      onClick={(e) => {
        if (tabName === 'home') {
          nav.navigate('MainScreen');
        } else if (tabName === 'discover') {
          nav.navigate('DiscoverTabScreen');
        } else if (tabName === 'settings') {
          nav.navigate('SettingsTabScreen');
        }
      }}
      data-testid={dataTestId}
    >
      <Icon size={iconSize} icon={icon} color={isActive ? 'accentDark' : 'muted'} />
      <BaseView style={{ position: 'relative' }}>
        {tabName === 'settings' && unreadNotificationCount > 0 && (
          <BaseView
            style={{
              position: 'absolute',
              top: -28,
              right: -10,
              width: 7,
              height: 7,
              backgroundColor: '#F55454',
              borderRadius: '50%',
              borderWidth: 1,
              borderColor: colors.surface
            }}
          ></BaseView>
        )}
      </BaseView>
    </Column>
  );
}
