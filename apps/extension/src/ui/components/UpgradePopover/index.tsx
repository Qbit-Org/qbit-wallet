import { useEffect, useState } from 'react';

import { fontSizes } from '@/ui/theme/font';
import { UPDATE_URL, VersionDetail } from '@qbit/wallet-shared';
import { useVersionInfo, useWallet } from '@qbit/wallet-state';

import { Button } from '../Button';
import { Column } from '../Column';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';

export const UpgradePopover = ({ onClose }: { onClose: () => void }) => {
  const versionInfo = useVersionInfo();

  const [versionDetail, setVersionDetail] = useState<VersionDetail>({
    version: '',
    changelogs: [],
    title: '',
    notice: ''
  });
  const wallet = useWallet();
  useEffect(() => {
    if (!versionInfo.newVersion) return;
    wallet
      .getVersionDetail(versionInfo.newVersion)
      .then((res) => {
        setVersionDetail(res);
      })
      .catch((e) => {
        console.log(e);
      });
  }, [versionInfo.newVersion]);
  return (
    <Popover onClose={onClose}>
      <Column justifyCenter itemsCenter>
        <Column mt="lg">
          <Text preset="bold" text={versionDetail.title} textCenter />
        </Column>

        <div style={{ marginTop: 8 }}>
          {versionDetail.changelogs.map((str, index) => (
            <div key={index} style={{ fontSize: fontSizes.sm }}>
              {str}
            </div>
          ))}
        </div>

        <Row full mt="lg">
          <Button
            text="Skip"
            full
            onClick={(e) => {
              if (onClose) {
                onClose();
              }
            }}
          />

          <Button
            text="Go to update"
            full
            preset="primary"
            onClick={(e) => {
              window.open(UPDATE_URL);
            }}
          />
        </Row>
      </Column>
    </Popover>
  );
};
