import { Button, Card, Column, Content, Footer, Header, Layout, Row, Text } from '@/ui/components';
import WebsiteBar from '@/ui/components/WebsiteBar';
import { CHAINS_MAP, chainForNetwork } from '@qbit/wallet-shared';
import type { QbitProviderApprovalContext, QbitProviderNetwork } from '@qbit/wallet-shared';
import { useApproval, useChainType, useI18n } from '@qbit/wallet-state';

interface Props {
  /** The approval this screen renders; its buttons settle only it. */
  approvalId?: string;
  params: {
    data: {
      network: QbitProviderNetwork;
    };
    /** The request's context: the chain it switches from. */
    context?: QbitProviderApprovalContext;
    session: {
      origin: string;
      icon: string;
      name: string;
    };
  };
}

export default function SwitchNetwork({ approvalId, params: { data, context, session } }: Props) {
  const chainType = useChainType();
  const from = CHAINS_MAP[context?.chain ?? chainType];
  const to = CHAINS_MAP[chainForNetwork(data.network)];
  const { t } = useI18n();

  const { resolveApproval, rejectApproval } = useApproval();

  const handleCancel = () => {
    rejectApproval(approvalId, t('user_rejected_the_request'));
  };

  const handleConnect = async () => {
    resolveApproval(approvalId);
  };

  return (
    <Layout>
      <Header>
        <WebsiteBar session={session} />
      </Header>
      <Content>
        <Column mt="lg">
          <Text text={t('allow_this_site_to_switch_the_network')} textCenter preset="title-bold" mt="lg" />

          <Row justifyBetween itemsCenter mt="lg">
            <Card preset="style2" px="lg">
              <Text text={from.label} preset="title-bold" />
            </Card>
            <Text text=">" />
            <Card preset="style2" px="lg">
              <Text text={to.label} preset="title-bold" />
            </Card>
          </Row>
        </Column>
      </Content>

      <Footer>
        <Row full>
          <Button text={t('cancel')} preset="default" onClick={handleCancel} full />
          <Button text={t('switch_network')} preset="primary" onClick={handleConnect} full />
        </Row>
      </Footer>
    </Layout>
  );
}
