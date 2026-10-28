import { Copy } from 'lucide-react';
import { shortAddress } from '@/ui/utils';
import { useAccountAddress, useTools } from '@qbit/wallet-state';

import { Row } from '../Row';
import { Text } from '../Text';

export function AddressBar() {
  const tools = useTools();
  const address = useAccountAddress();
  return (
    <Row selfItemsCenter itemsCenter onClick={(e) => tools.copyToClipboard(address)}>
      <Text text={shortAddress(address)} color="textDim" />
      <Copy size={14} style={{ color: 'var(--qbit-muted)' }} />
    </Row>
  );
}
