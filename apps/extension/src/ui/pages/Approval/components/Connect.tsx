import { CircleCheck, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Card, Checkbox, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import WebsiteBar from '@/ui/components/WebsiteBar';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { shortAddress } from '@/ui/utils';
import { Account, QbitProviderApprovalContext } from '@qbit/wallet-shared';
import {
  useApproval,
  useConnectWebsiteCheck,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n
} from '@qbit/wallet-state';
import ProviderContextCard from './ProviderContextCard';
import WebsiteCheckWarning from './WebsiteCheckWarning';

interface MyItemProps {
  account?: Account;
  selected?: boolean;
  onClick?: () => void;
}

export interface ItemData {
  key: string;
  account?: Account;
}

export function MyItem({ account, selected, onClick }: MyItemProps, ref) {
  if (!account) {
    return <div />;
  }

  return (
    <Card justifyBetween mt="sm" onClick={onClick} data-testid="connect-account-item">
      <Row>
        <Column style={{ width: 20 }} selfItemsCenter>
          {selected && (
            <Icon>
              <CircleCheck size="1em" />
            </Icon>
          )}
        </Column>
        <Column>
          <Text text={account.alianName} />
          <Text text={`${shortAddress(account.address, 20)}`} preset="sub" wrap />
        </Column>
      </Row>
      <Column relative></Column>
    </Card>
  );
}

interface Props {
  /** The approval this screen renders; Connect and Cancel settle only it. */
  approvalId?: string;
  params: {
    data?: {
      context?: QbitProviderApprovalContext;
    };
    session: {
      origin: string;
      icon: string;
      name: string;
    };
  };
}

export default function Connect({ approvalId, params: { data, session } }: Props) {
  const { resolveApproval, rejectApproval } = useApproval();
  const { t } = useI18n();

  const handleCancel = () => {
    rejectApproval(approvalId, t('user_rejected_the_request'));
  };

  const currentKeyring = useCurrentKeyring();
  const currentAccount = useCurrentAccount();
  const { status, warning, retry, guardVersionRef, blockedRef } = useConnectWebsiteCheck(session.origin);
  const renderedGuardVersion = guardVersionRef.current;
  const [acknowledgedOrigin, setAcknowledgedOrigin] = useState('');
  const isUnverifiedWebsite = status === 'unverified';
  const hasAcknowledgedUnverifiedWebsite = isUnverifiedWebsite && acknowledgedOrigin === session.origin;

  const handleConnect = async () => {
    if (status === 'unverified' && !hasAcknowledgedUnverifiedWebsite) return;
    if (status !== 'clear' && status !== 'unverified') return;
    if (renderedGuardVersion !== guardVersionRef.current || blockedRef.current) return;
    resolveApproval(approvalId);
  };

  useEffect(() => {
    setAcknowledgedOrigin('');
  }, [session.origin, status]);

  if (status === 'checking') {
    return (
      <Layout>
        <Header>
          <WebsiteBar session={session} />
        </Header>
        <Content itemsCenter justifyCenter>
          <Column itemsCenter>
            <Icon size={fontSizes.xxxl} color="gold">
              <LoaderCircle className="icon-spin" size="1em" />
            </Icon>
            <Text text={t('checking_website_safety')} textCenter mt="md" />
          </Column>
        </Content>
        <Footer>
          <Row full>
            <Button
              text={t('cancel')}
              preset="default"
              onClick={handleCancel}
              full
              data-testid="website-check-loading-cancel-button"
            />
          </Row>
        </Footer>
      </Layout>
    );
  }

  if (status === 'blocked') {
    return (
      <Layout>
        <Header>
          <WebsiteBar session={session} />
        </Header>
        <Content>
          <Column>
            <Text text={t('phishing_detection')} preset="title-bold" textCenter mt="xxl" />
            <Text text={t('malicious_behavior_and_suspicious_activity_have_be')} mt="md" />
            <Text text={t('your_access_to_this_page_has_been_restricted_by_un')} mt="md" />
          </Column>
        </Content>

        <Footer>
          <Row full>
            <Button text={t('reject_blocked_request')} preset="danger" onClick={handleCancel} full />
          </Row>
        </Footer>
      </Layout>
    );
  }

  return (
    <Layout>
      <Header>
        <WebsiteBar session={session} />
      </Header>
      <Content>
        <Column>
          {isUnverifiedWebsite && <WebsiteCheckWarning warning={warning} onRetry={retry} />}

          <Text text="Connect with Qbit Wallet" preset="title-bold" textCenter mt="lg" />
          <Text text={t('select_the_account_to_use_on_this_site')} textCenter mt="md" />
          <Text text={t('only_connect_with_sites_you_trust')} preset="sub" textCenter mt="md" />

          {/* The account being connected is the primary content; provider
              metadata is secondary and follows it. */}
          <Text text={currentKeyring.alianName} preset="sub" />
          <MyItem account={currentAccount} />

          <ProviderContextCard context={data?.context} />
        </Column>
      </Content>

      <Footer>
        {isUnverifiedWebsite && (
          <Checkbox
            checked={hasAcknowledgedUnverifiedWebsite}
            onChange={(event) => setAcknowledgedOrigin(event.target.checked ? session.origin : '')}
            style={{ marginBottom: spacing.small }}
            data-testid="unverified-website-confirmation"
          >
            <Text text={t('unverified_website_confirmation')} preset="sub-bold" />
          </Checkbox>
        )}
        <Row full>
          <Button
            text={t('cancel')}
            preset="default"
            onClick={handleCancel}
            full
            data-testid={isUnverifiedWebsite ? 'website-check-cancel-button' : undefined}
          />
          <Button
            text={t('connect')}
            preset="primary"
            onClick={handleConnect}
            disabled={isUnverifiedWebsite && !hasAcknowledgedUnverifiedWebsite}
            aria-disabled={isUnverifiedWebsite && !hasAcknowledgedUnverifiedWebsite}
            full
            data-testid={isUnverifiedWebsite ? 'website-check-connect-button' : undefined}
          />
        </Row>
      </Footer>
    </Layout>
  );
}
