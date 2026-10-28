import { Card, Column, Content, Header, Layout, Text } from '@/ui/components';
import { useDeveloperMode, useI18n, useNavigation } from '@qbit/wallet-state';

const isDevelopment = process.env.NODE_ENV === 'development';

export default function AddKeyringScreen() {
  const nav = useNavigation();
  const { t } = useI18n();
  const developerMode = useDeveloperMode();

  return (
    <Layout>
      <Header onBack={() => nav.goBack()} title={t('create_a_new_wallet')} />
      <Content>
        <Column>
          <Text text={t('create_wallet')} preset="regular-bold" />

          <Card
            justifyCenter
            onClick={(e) => {
              nav.navigate('CreateHDWalletScreen', { isImport: false });
            }}
            data-testid="create-wallet-with-mnemonics-option">
            <Column full justifyCenter>
              <Text text={t('create_with_mnemonics_24words')} size="sm" />
            </Column>
          </Card>

          <Text text={t('restore_wallet')} preset="regular-bold" mt="lg" />

          <Card
            justifyCenter
            onClick={(e) => {
              nav.navigate('CreateHDWalletScreen', { isImport: true });
            }}
            data-testid="restore-from-mnemonics-option">
            <Column full justifyCenter>
              <Text text={t('restore_from_mnemonics_12words24words')} size="sm" />
            </Column>
          </Card>

          {developerMode && (
            <>
              <Text text={t('connect_to_readonly_wallet')} preset="regular-bold" mt="lg" />

              <Card
                justifyCenter
                onClick={() => {
                  nav.navigate('CreateReadonlyWalletScreen');
                }}>
                <Column full justifyCenter>
                  <Text text={t('readonly_wallet')} size="sm" />
                </Column>
              </Card>
            </>
          )}

          {isDevelopment && (
            <>
              <Text text={t('watch_address_wallet')} preset="regular-bold" mt="lg" />

              <Card
                justifyCenter
                onClick={() => {
                  nav.navigate('CreateWatchWalletScreen');
                }}>
                <Column full justifyCenter>
                  <Text text={t('watch_address_wallet')} size="sm" />
                </Column>
              </Card>
            </>
          )}
        </Column>
      </Content>
    </Layout>
  );
}
