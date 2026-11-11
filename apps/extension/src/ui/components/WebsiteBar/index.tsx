import { BadgeCheck } from 'lucide-react';

import { fontSizes } from '@/ui/theme/font';
import { formatSessionIcon } from '@/ui/utils';
import { useI18n } from '@qbit/wallet-state';

import { Card } from '../Card';
import { Column } from '../Column';
import { Icon } from '../Icon';
import { Image } from '../Image';
import { Row } from '../Row';
import { Text } from '../Text';

interface WebsiteBarProps {
  session: { origin: string; icon: string; name: string };
  /** Marks the official Qbit website, from its `trusted` website-check verdict. */
  trusted?: boolean;
}

const WebsiteBar = ({ session, trusted = false }: WebsiteBarProps) => {
  const { t } = useI18n();

  return (
    <Card preset="style2" selfItemsCenter>
      <Column itemsCenter gap="sm">
        <Row itemsCenter>
          <Image src={formatSessionIcon(session)} size={fontSizes.logo} />
          <Text text={session.origin} />
        </Row>
        {trusted && (
          <Row itemsCenter gap="sm" data-testid="website-bar-trusted">
            <Icon color="success" size={fontSizes.xs}>
              <BadgeCheck size="1em" />
            </Icon>
            <Text text={t('official_qbit_website')} size="xs" color="success" />
          </Row>
        )}
      </Column>
    </Card>
  );
};

export default WebsiteBar;
