import { Card, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { BaseView } from '@/ui/components/BaseView';
import { NavTabBar } from '@/ui/components/NavTabBar';
import { SwitchNetworkBar } from '@/ui/components/SwitchNetworkBar';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { DISCORD_URL, TWITTER_URL } from '@qbit/wallet-shared';
import {
  SettingsItemType,
  useChain,
  useI18n,
  useNavigation,
  useSettingsTabScreenLogic,
  useUnreadNotificationsCount,
  useVersionInfo
} from '@qbit/wallet-state';

export default function SettingsTabScreen() {
  const versionInfo = useVersionInfo();
  const nav = useNavigation();
  const { t } = useI18n();
  const { websiteUrl } = useChain();
  const unreadNotificationCount = useUnreadNotificationsCount();
  const {
    settings_connectedSites,
    settings_switchNetwork,
    settings_addressBook,
    settings_addressType,
    settings_appearance,
    settings_advanced,
    settings_aboutus,
    settings_lockwallet
  } = useSettingsTabScreenLogic();

  const renderSettingsItem = (item: SettingsItemType) => (
    <Card
      key={item.key}
      data-testid={item.key}
      onClick={() => item.onClick && item.onClick()}
      style={{
        height: '64px',
        flexShrink: 0,
        borderRadius: 0,
        background: colors.surface,
        borderColor: colors.border,
        padding: '0 16px',
        margin: 0
      }}
    >
      <Row full justifyBetween style={{ height: '100%', alignItems: 'center' }}>
        <Row style={{ minWidth: 0, alignItems: 'center' }}>
          <Icon icon={item.icon as any} size={fontSizes.iconMiddle} color="textDim" />
          <Column style={{ gap: spacing.tiny, minWidth: 0, flex: 1, marginLeft: spacing.tiny }}>
            <Row justifyBetween>
              <Text text={item.label || item.desc} preset="regular" size="sm" style={{ color: colors.text }} />
              {item.badge && (
                <Text
                  text={item.badge}
                  preset="badge"
                  style={{
                    marginLeft: '6px'
                  }}
                />
              )}
            </Row>
          </Column>
        </Row>
        <Row style={{ alignItems: 'center', gap: spacing.small }}>
          {item.right && <Icon icon="right" size={fontSizes.lg} color="textDim" />}
        </Row>
      </Row>
    </Card>
  );

  const renderGroup = (items: SettingsItemType[]) => (
    <Column fullX style={{ gap: spacing.extraSmall }}>
      {items.filter((v) => v).map((item) => renderSettingsItem(item))}
    </Column>
  );

  return (
    <Layout>
      <Header
        type="home"
        LeftComponent={
          <Row>
            <Text preset="title-bold" text={t('settings')} />
          </Row>
        }
        RightComponent={
          <Row itemsCenter>
            <BaseView style={{ position: 'relative' }}>
              <Icon
                icon="notification"
                size={20}
                color="textDim"
                onClick={() => {
                  nav.navigate('NotificationListScreen');
                }}
              />
              {unreadNotificationCount ? (
                <BaseView
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    width: 7,
                    height: 7,
                    backgroundColor: '#F55454',
                    borderRadius: '50%',
                    borderWidth: 1,
                    borderColor: colors.surface
                  }}
                ></BaseView>
              ) : null}
            </BaseView>
            <BaseView style={{ position: 'relative', marginRight: 5 }}>
              <Icon
                icon="language"
                size={20}
                color="textDim"
                onClick={() => {
                  nav.navigate('LanguageScreen');
                }}
              />
            </BaseView>

            <SwitchNetworkBar />
          </Row>
        }
      />
      <Content>
        <Column>
          <Column style={{ alignItems: 'center' }}>
            <Column fullX>
              {renderGroup([
                settings_connectedSites,
                settings_switchNetwork,
                settings_addressBook,
                settings_addressType,
                settings_appearance,
                settings_advanced,
                settings_lockwallet,
                settings_aboutus
              ])}
            </Column>
          </Column>

          <Row justifyCenter gap="xl" mt="lg">
            <Icon
              icon="website"
              size={fontSizes.iconMiddle}
              color="textDim"
              onClick={() => {
                nav.navToUrl(websiteUrl);
              }}
            />
            <Icon
              icon="discord"
              size={fontSizes.iconMiddle}
              color="textDim"
              onClick={() => {
                nav.navToUrl(DISCORD_URL);
              }}
            />

            <Icon
              icon="twitter"
              size={fontSizes.iconMiddle}
              color="textDim"
              onClick={() => {
                nav.navToUrl(TWITTER_URL);
              }}
            />
          </Row>
          <Text text={`${t('version')} ${versionInfo.currentVesion}`} preset="sub" textCenter />
        </Column>
      </Content>
      <Footer px="zero" py="zero">
        <NavTabBar tab="settings" />
      </Footer>
    </Layout>
  );
}
