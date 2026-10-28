import { Card, Column, Row, Text } from '@/ui/components';
import type { QbitProviderApprovalContext } from '@qbit/wallet-shared';

export default function ProviderContextCard({ context }: { context?: QbitProviderApprovalContext }) {
  if (!context) return null;

  return (
    <Card data-testid="qbit-provider-context">
      <Column gap="sm" fullX>
        <Row justifyBetween fullX>
          <Text text="Origin" color="textDim" />
          <Text text={context.origin} wrap />
        </Row>
        <Row justifyBetween fullX>
          <Text text="Account" color="textDim" />
          <Text text={context.account || 'No active account'} wrap />
        </Row>
        <Row justifyBetween fullX>
          <Text text="Chain" color="textDim" />
          <Text text={context.chain} wrap />
        </Row>
        <Row justifyBetween fullX>
          <Text text="Network" color="textDim" />
          <Text text={context.network} wrap />
        </Row>
      </Column>
    </Card>
  );
}
