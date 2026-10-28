import { Copy } from 'lucide-react';
import { copyToClipboard, shortAddress } from '@/ui/utils';
import { useI18n } from '@qbit/wallet-state';
import { useTools } from '@qbit/wallet-state';

import { Row } from '../Row';
import { Text } from '../Text';

export function Section({
  value,
  title,
  link,
  showCopyIcon,
  maxLength = 20,
  rightComponent
}: {
  value: string | number;
  title: string;
  link?: string;
  showCopyIcon?: boolean;
  maxLength?: number;
  rightComponent?: React.ReactNode;
}) {
  const tools = useTools();
  const { t } = useI18n();

  let displayText = value?.toString();
  if (value && typeof value === 'string' && value.length > maxLength) {
    displayText = shortAddress(value, maxLength / 2);
  }

  return (
    <Row
      justifyBetween
      itemsCenter
      px="md"
      style={{
        minHeight: 25
      }}
    >
      <Text text={title} preset="regular" />
      {rightComponent ? (
        rightComponent
      ) : (
        <Row
          onClick={() => {
            if (link) {
              window.open(link);
            } else {
              copyToClipboard(value).then(() => {
                tools.toastSuccess(t('copied'));
              });
            }
          }}
        >
          <Text text={displayText} preset={link ? 'link' : 'regular'} size="xs" wrap />
          {showCopyIcon && <Copy size={14} style={{ color: 'var(--qbit-muted)' }} />}
        </Row>
      )}
    </Row>
  );
}
