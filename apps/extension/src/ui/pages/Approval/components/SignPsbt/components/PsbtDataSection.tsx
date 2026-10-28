import { useState } from 'react';

import { Card, Column, Icon, Row, Text } from '@/ui/components';
import { Popover } from '@/ui/components/Popover';
import { shortAddress } from '@/ui/utils';

import { ToSignData } from '@qbit/wallet-shared';
import { useI18n, useTools } from '@qbit/wallet-state';
import { SignPsbtSection } from './Section';

const PsbtDataSection = ({ toSignData }: { toSignData: ToSignData }) => {
  const tools = useTools();
  const { t } = useI18n();
  const [detailVisible, setDetailVisible] = useState(false);
  const byteSize = `${toSignData.psbtHex.length / 2} bytes`;
  return (
    <SignPsbtSection title={t('psbt_data')}>
      <Card
        style={{
          backgroundColor: 'var(--qbit-paper)'
        }}
      >
        <Column>
          <Row
            itemsCenter
            onClick={() => {
              setDetailVisible(true);
            }}
            data-testid="psbt-data-preview"
          >
            <Text text={shortAddress(toSignData.psbtHex, 18)} wrap />
            <Icon icon="eye" color="textDim" />
          </Row>

          <Row itemsCenter>
            <Text text={byteSize} color="textDim" />
          </Row>
        </Column>
      </Card>

      {detailVisible && (
        <Popover
          onClose={() => {
            setDetailVisible(false);
          }}
        >
          <Column>
            <Text text={t('psbt_data')} textCenter />
            <Card
              preset="style2"
              onClick={() => {
                tools.copyToClipboard(toSignData.psbtHex);
              }}
              style={{ backgroundColor: 'var(--qbit-canvas)' }}
              data-testid="psbt-data-full"
            >
              <Row itemsCenter>
                <Text
                  text={toSignData.psbtHex}
                  size="xs"
                  style={{
                    overflowWrap: 'anywhere',
                    maxHeight: 240,
                    overflowY: 'auto'
                  }}
                />
                <Icon icon="copy" />
              </Row>
            </Card>
            <Text text={byteSize} color="textDim" textCenter />
          </Column>
        </Popover>
      )}
    </SignPsbtSection>
  );
};

export default PsbtDataSection;
