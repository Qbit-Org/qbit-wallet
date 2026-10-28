import { Copy } from 'lucide-react';
import { shortAddress } from '@/ui/utils';
import { useCurrentAccount, useNavigation, useTools } from '@qbit/wallet-state';

import { Column } from '../Column';
import { Icon } from '../Icon';
import { Row } from '../Row';
import { Text } from '../Text';
import './index.less';

const AccountSelect = () => {
  const nav = useNavigation();
  const currentAccount = useCurrentAccount();
  const tools = useTools();
  const address = currentAccount.address;

  return (
    <Row
      justifyBetween
      px="md"
      py="md"
      bg="card"
      itemsCenter
      style={{
        borderRadius: 0,
        border: '1px solid var(--qbit-line)',
        boxShadow: '0 8px 24px var(--qbit-shadow)'
      }}
    >
      <Row style={{ flex: 1 }}>
        <Icon size={15} icon="user" style={{ marginLeft: 10 }} />
      </Row>

      <Column
        justifyCenter
        rounded
        px="sm"
        style={{
          flex: 1
        }}
        onClick={(e) => tools.copyToClipboard(address)}
      >
        <Text text={shortAddress(currentAccount?.alianName, 8)} textCenter ellipsis />
        <Row selfItemsCenter itemsCenter>
          <Text text={shortAddress(address)} color="textDim" />
          <Copy size={14} style={{ color: 'var(--qbit-muted)' }} />
        </Row>
      </Column>

      <Row
        style={{ flex: 1 }}
        fullY
        py="md"
        justifyEnd
        itemsCenter
        onClick={(e) => {
          nav.navigate('SwitchAccountScreen');
        }}
        data-testid="account-select"
      >
        <Icon size={15} icon="right" style={{ marginRight: 10 }} />
      </Row>
    </Row>
  );
};

export default AccountSelect;
