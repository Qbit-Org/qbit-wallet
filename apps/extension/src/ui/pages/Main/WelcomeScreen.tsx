/* eslint-disable quotes */
import { Button, Column, Content, Layout, Logo, Row, Text } from '@/ui/components';
import { useI18n, useWallet } from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

export default function WelcomeScreen() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const { t } = useI18n();
  return (
    <Layout>
      <Content preset="middle">
        <Column fullX>
          <Row justifyCenter>
            <Logo preset="large" data-testid="welcome-logo" />
          </Row>
          <Column gap="xl" mt="xxl">
            <Text text={t('welcome_screen_title')} preset="sub" textCenter data-testid="welcome-title" />

            <Button
              text={t('create_new_wallet')}
              preset="primary"
              data-testid="create-new-wallet-button"
              onClick={async () => {
                const isBooted = await wallet.isBooted();
                if (isBooted) {
                  navigate('CreateHDWalletScreen', { isImport: false });
                } else {
                  navigate('CreatePasswordScreen', { isNewAccount: true });
                }
              }}
            />
            <Button
              text={t('i_already_have_a_wallet')}
              preset="default"
              data-testid="import-wallet-button"
              onClick={async () => {
                const isBooted = await wallet.isBooted();
                if (isBooted) {
                  navigate('CreateHDWalletScreen', { isImport: true });
                } else {
                  navigate('CreatePasswordScreen', { isNewAccount: false });
                }
              }}
            />
          </Column>
        </Column>
      </Content>
    </Layout>
  );
}
