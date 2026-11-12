import { Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { BaseView } from '@/ui/components/BaseView';
import { NavTabBar } from '@/ui/components/NavTabBar';
import { SwitchNetworkBar } from '@/ui/components/SwitchNetworkBar';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { DISCORD_URL, TWITTER_URL } from '@qbit/wallet-shared';
import {
  SettingsItemType,
  useChain,
  useI18n,
  useNavigation,
  useSettingsTabScreenLogic,
  useVersionInfo
} from '@qbit/wallet-state';

import { SettingsItemRow } from './SettingsItemRow';

export default function SettingsTabScreen() {
  const versionInfo = useVersionInfo();
  const nav = useNavigation();
  const { t } = useI18n();
  const { websiteUrl } = useChain();
  const {
    settings_connectedSites,
    settings_switchNetwork,
    settings_addressBook,
    settings_addressType,
    settings_security,
    settings_appearance,
    settings_advanced,
    settings_aboutus,
    settings_lockwallet
  } = useSettingsTabScreenLogic();

  const renderGroup = (items: SettingsItemType[]) => (
    <Column fullX style={{ gap: spacing.extraSmall }}>
      {items
        .filter((v) => v)
        .map((item) => (
          <SettingsItemRow key={item.key} item={item} />
        ))}
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
                settings_security,
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
