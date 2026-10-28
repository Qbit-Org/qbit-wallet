import { useEffect, useState } from 'react';

import { Card, Column, Content, Header, Icon, Image, Layout, Row, Text } from '@/ui/components';
import { Empty } from '@/ui/components/Empty';
import { fontSizes } from '@/ui/theme/font';
import { useI18n, useWallet } from '@qbit/wallet-state';
import { formatSessionIcon } from '@/ui/utils';
import { ConnectedSite } from '@qbit/wallet-shared';

export default function ConnectedSitesScreen() {
  const wallet = useWallet();
  const { t } = useI18n();

  const [sites, setSites] = useState<ConnectedSite[]>([]);

  const getSites = async () => {
    const sites = await wallet.getConnectedSites();
    setSites(sites.filter((v) => v.origin));
  };

  useEffect(() => {
    getSites();
  }, []);

  const handleRemove = async (origin: string) => {
    await wallet.removeConnectedSite(origin);
    getSites();
  };
  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('connected_sites')}
      />
      <Content>
        {sites.length > 0 ? (
          <Column>
            {sites.map((item, index) => {
              return (
                <Card key={item.origin} data-testid={`connected-site-${index}`}>
                  <Row full justifyBetween itemsCenter>
                    <Row itemsCenter>
                      <Image src={formatSessionIcon(item)} size={fontSizes.logo} />
                      <Text text={item.origin} preset="sub" />
                    </Row>
                    <Column justifyCenter>
                      <Icon
                        icon="close"
                        data-testid={`revoke-site-${index}`}
                        onClick={() => {
                          handleRemove(item.origin);
                        }}
                      />
                    </Column>
                  </Row>
                </Card>
              );
            })}
          </Column>
        ) : (
          <Column full justifyCenter itemsCenter style={{ flex: 1 }}>
            <Empty text={t('no_connected_sites')} />
          </Column>
        )}
      </Content>
    </Layout>
  );
}
