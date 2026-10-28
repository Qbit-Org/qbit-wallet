import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Button, Card, Column, Content, Footer, Header, Icon, Image, Layout, Row, Text } from '@/ui/components';
import WebsiteBar from '@/ui/components/WebsiteBar';
import { CHAINS_MAP } from '@qbit/wallet-shared';
import { useApproval, useChainType, useI18n } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

interface Props {
  /** The approval this screen renders; its buttons settle only it. */
  approvalId?: string;
  params: {
    data: {
      chain: ChainType;
    };
    session: {
      origin: string;
      icon: string;
      name: string;
    };
  };
}

export default function SwitchChain({ approvalId, params: { data, session } }: Props) {
  const chainType = useChainType();
  const from = CHAINS_MAP[chainType];
  const to = CHAINS_MAP[data.chain];
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
          <Text text={t('allow_this_site_to_switch_the_chain')} textCenter preset="title-bold" mt="lg" />

          <Column justifyBetween itemsCenter mt="lg">
            <Card
              style={{
                backgroundColor: 'var(--qbit-paper)',
                borderRadius: 0,
                borderColor: 'var(--qbit-line)'
              }}
              mt="lg"
            >
              <Row fullX>
                <Row itemsCenter>
                  <Image src={IMAGE_SOURCE_MAP[from.icon]} size={30} />
                  <Text text={from.label} />
                </Row>
              </Row>
            </Card>

            <Icon icon="down" />
            <Card
              style={{
                backgroundColor: 'var(--qbit-paper)',
                borderRadius: 0,
                borderColor: 'var(--qbit-line)'
              }}
              mt="lg"
            >
              <Row fullX>
                <Row itemsCenter>
                  <Image src={IMAGE_SOURCE_MAP[to.icon]} size={30} />
                  <Text text={to.label} />
                </Row>
              </Row>
            </Card>
          </Column>
        </Column>
      </Content>

      <Footer>
        <Row full>
          <Button text={t('cancel')} preset="default" onClick={handleCancel} full />
          <Button text={t('switch_chain')} preset="primary" onClick={handleConnect} full />
        </Row>
      </Footer>
    </Layout>
  );
}
